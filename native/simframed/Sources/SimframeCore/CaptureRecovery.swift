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

    public private(set) var consecutiveFailures = 0
    private let threshold: Int

    public init(threshold: Int = CaptureRecovery.reattachAfterFailures) {
        self.threshold = threshold
    }

    public mutating func captureSucceeded() {
        consecutiveFailures = 0
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
            return .success(failures)
        } catch {
            // Deliberately not reset: if the port cannot be re-resolved, the
            // next failure should try again rather than wait for another six.
            return .failure(error)
        }
    }
}
