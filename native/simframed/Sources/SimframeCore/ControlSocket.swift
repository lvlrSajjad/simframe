import Foundation
import PrivateAPI

/// A per-device Unix domain socket carrying one JSON object per line.
///
/// Unix sockets rather than TCP because the permission model is the file
/// system's: mode 0600 means only this user can drive the simulator, with no
/// port to collide and nothing reachable from the network.
public final class ControlSocket {
    public typealias Handler = ([String: Any]) -> [String: Any]

    private let path: String
    private let handler: Handler
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    // Requests run off the capture loop: a swipe sleeps for its whole duration
    // and must not stall frame capture.
    private let workQueue = DispatchQueue(label: "simframe.control", qos: .userInitiated)
    /// Identity of the socket file this instance created, so shutdown can tell
    /// its own socket from one a successor has since bound at the same path.
    private var boundIno: ino_t = 0
    private var boundDev: dev_t = 0

    public init(path: String, handler: @escaping Handler) {
        self.path = path
        self.handler = handler
    }

    public func start() throws {
        unlink(path)
        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFD >= 0 else { throw SocketError.failed("socket(): \(errno)") }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLen else { throw SocketError.failed("socket path too long") }
        withUnsafeMutablePointer(to: &addr.sun_path) { p in
            p.withMemoryRebound(to: CChar.self, capacity: maxLen) { dst in
                _ = strcpy(dst, path)
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, size) }
        }
        guard bound == 0 else { close(listenFD); throw SocketError.failed("bind(): \(errno)") }
        // Only this user may drive the device.
        chmod(path, 0o600)
        var bornStat = stat()
        if stat(path, &bornStat) == 0 {
            boundIno = bornStat.st_ino
            boundDev = bornStat.st_dev
        }
        guard listen(listenFD, 8) == 0 else { close(listenFD); throw SocketError.failed("listen(): \(errno)") }

        let source = DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: workQueue)
        source.setEventHandler { [weak self] in self?.acceptOne() }
        source.resume()
        acceptSource = source
    }

    private func acceptOne() {
        let fd = accept(listenFD, nil, nil)
        guard fd >= 0 else { return }
        defer { close(fd) }
        guard let request = readLine(fd) else { return }

        var response: [String: Any]
        if let data = request.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            response = handler(object)
            if let id = object["id"] { response["id"] = id }
        } else {
            response = ["ok": false, "error": "malformed request"]
        }
        if let out = try? JSONSerialization.data(withJSONObject: response) {
            var line = out
            line.append(0x0A)
            _ = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        }
    }

    private func readLine(_ fd: Int32) -> String? {
        var buffer = [UInt8]()
        var byte: UInt8 = 0
        while read(fd, &byte, 1) == 1 {
            if byte == 0x0A { break }
            buffer.append(byte)
            if buffer.count > 1 << 20 { return nil }
        }
        return buffer.isEmpty ? nil : String(decoding: buffer, as: UTF8.self)
    }

    public func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 { close(listenFD) }
        listenFD = -1
        // Only remove the socket if it is still the one we created.
        //
        // A restart binds a fresh socket at the same path, and a dying daemon
        // that unlinks blindly deletes its *successor's* socket. Capture keeps
        // working — that is file-based — so the only symptom is input quietly
        // dropping to idb, which is slower and has different semantics. That is
        // exactly the kind of invisible downgrade this tool is supposed to
        // refuse to have.
        var current = stat()
        if stat(path, &current) == 0, current.st_ino == boundIno, current.st_dev == boundDev {
            unlink(path)
        }
        boundIno = 0
        boundDev = 0
    }

    public enum SocketError: Error, CustomStringConvertible {
        case failed(String)
        public var description: String {
            switch self { case .failed(let d): return "control socket: \(d)" }
        }
    }
}
