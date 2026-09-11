import Foundation
import PrivateAPI

/// When a run of failed captures means the display port itself is gone.
///
/// The port can be torn down and rebuilt under a running daemon, and every read
/// on the old descriptor returns nil from then on. Observed on a device awake
/// and visible the whole time: six minutes of "the display surface could not be
/// read", cured instantly by restarting the daemon.
///
/// This lives in its own type for one reason: the recovery path only ever runs
/// in the situation nobody is watching, and inline in the capture loop it could
/// not be tested at all. A teardown cannot be induced on demand, but the
/// decision to re-resolve and the act of re-resolving both can be.
public struct CaptureRecovery {
    /// Roughly three seconds of failed reads at the loop's half-second back-off.
    /// Long enough not to thrash on a momentary hiccup, short enough that nobody
    /// watches a dead capture loop and wonders.
    public static let reattachAfterFailures = 6

    /// When re-resolving the port has demonstrably not helped.
    ///
    /// Re-resolving *succeeds* in the pathology this exists for: the call
    /// returns a fresh descriptor, the callback re-arms, and every read still
    /// fails. Because a successful re-resolve resets the failure count, that
    /// state loops — six failures, re-resolve, six failures — and no count of
    /// consecutive failures ever grows large enough to notice it. Observed
    /// three times in one afternoon on a simulator driven hard for ten minutes;
    /// only restarting the device cured it.
    ///
    /// So the signal is re-resolves, not failures. Two of them means the port
    /// was not the problem.
    public static let stalledAfterReattaches = 2

    /// And the other way it goes wrong: re-resolving itself failing, where the
    /// failure count does keep growing because nothing resets it.
    public static let stalledAfterFailures = reattachAfterFailures * 3

    /// How many times to rebind the device per stall episode.
    ///
    /// Bounded because a rebind asks CoreSimulator for the whole device list
    /// and warms input: worth doing when re-resolving has failed twice, not
    /// worth doing every half second forever. Two attempts, then the loop goes
    /// back to reporting the state it is in.
    public static let maxRebinds = 2

    public private(set) var consecutiveFailures = 0
    /// Successful re-resolves since the last real frame.
    public private(set) var reattaches = 0
    /// Full rebinds since the last real frame.
    public private(set) var rebinds = 0
    private let threshold: Int

    public init(threshold: Int = CaptureRecovery.reattachAfterFailures) {
        self.threshold = threshold
    }

    /// Is capture wedged rather than merely stumbling?
    ///
    /// Deliberately a state and not an event: the daemon reports it, and does
    /// not act on it. A capture loop that restarted the device it is watching
    /// would be a tool that reaches for the mains when a reading looks wrong.
    public var isStalled: Bool {
        reattaches >= Self.stalledAfterReattaches || consecutiveFailures >= Self.stalledAfterFailures
    }

    /// Has re-resolving the port had its chance?
    ///
    /// Two successful re-resolves with no frame between them is the port
    /// telling us it was never the problem. That was already the *stalled*
    /// signal; now it is also the trigger to try the one thing that had only
    /// ever been done by hand — rebinding to the device, which is what
    /// restarting the daemon did.
    public var needsRebind: Bool {
        reattaches >= Self.stalledAfterReattaches && rebinds < Self.maxRebinds
    }

    /// Both rungs of the ladder have been tried and no frame has arrived since.
    ///
    /// What happens after the ladder runs out was left implicit, and the
    /// implicit answer was "go back to the bottom rung forever". Measured from a
    /// real wedge: **670 re-resolves against 42 rebinds** in one log. Once
    /// `rebinds` hits `maxRebinds` — and it only resets on a real frame —
    /// `needsRebind` is false for good, so every sixth failure re-resolved a
    /// port that two rebinds had already proved was not the problem, at 600ms a
    /// go, each time logging a message that calls the condition "usually
    /// transient".
    ///
    /// That is why a wedged device reads as the tool hanging rather than the
    /// tool reporting. The state is unchanged in spirit — the daemon still only
    /// reports, and restarting the device stays the operator's call — but it can
    /// stop pretending it has something left to try.
    public var recoveryExhausted: Bool {
        rebinds >= Self.maxRebinds && reattaches >= Self.stalledAfterReattaches
    }

    public mutating func captureSucceeded() {
        consecutiveFailures = 0
        // A real frame is the only evidence that health is back. Resetting this
        // anywhere else — on a re-resolve, say — is how the loop above stayed
        // invisible.
        reattaches = 0
        rebinds = 0
    }

    /// Records a failure and says whether the port is now due a re-resolve.
    public mutating func captureFailed() -> Bool {
        consecutiveFailures += 1
        return consecutiveFailures >= threshold
    }

    /// Re-resolve the port and re-arm the damage callback.
    ///
    /// Both halves matter and only one is obvious: a fresh descriptor with no
    /// callback registered on it produces a daemon that has recovered and will
    /// never notice another change, which looks exactly like the failure it just
    /// recovered from.
    public mutating func reattach(
        platform: SimulatorPlatform,
        onDamage: @escaping () -> Void
    ) -> Result<Int, Error> {
        let failures = consecutiveFailures
        do {
            _ = try platform.reattachDisplay()
            try platform.observeChanges(onDamage)
            consecutiveFailures = 0
            reattaches += 1
            return .success(failures)
        } catch {
            // Deliberately not reset: if the port cannot be re-resolved, the
            // next failure should try again rather than wait for another six.
            return .failure(error)
        }
    }

    /// Rebind to the device itself, and re-arm the callback on the new port.
    ///
    /// The escalation `needsRebind` gates. Re-arming matters here for the same
    /// reason it does in `reattach`: a fresh descriptor with no callback on it
    /// is a daemon that has recovered and will never notice another change,
    /// which looks exactly like the failure it just recovered from.
    public mutating func rebind(
        platform: SimulatorPlatform,
        udid: String?,
        onDamage: @escaping () -> Void
    ) -> Result<Int, Error> {
        let failures = consecutiveFailures
        rebinds += 1
        do {
            _ = try platform.reattachDevice(udid: udid)
            try platform.observeChanges(onDamage)
            consecutiveFailures = 0
            // `reattaches` is deliberately left alone. It is the evidence that
            // the port was not the problem, and a rebind does not make that
            // untrue — only a real frame does, in captureSucceeded().
            return .success(failures)
        } catch {
            return .failure(error)
        }
    }
}
