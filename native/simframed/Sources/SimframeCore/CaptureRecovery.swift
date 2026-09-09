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

    public private(set) var consecutiveFailures = 0
    /// Successful re-resolves since the last real frame.
    public private(set) var reattaches = 0
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

    public mutating func captureSucceeded() {
        consecutiveFailures = 0
        // A real frame is the only evidence that health is back. Resetting this
        // anywhere else — on a re-resolve, say — is how the loop above stayed
        // invisible.
        reattaches = 0
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
}
