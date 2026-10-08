// Opens a movie with AVFoundation (the framework QuickTime Player uses), prints JSON with its duration, frame rate and
// whether a frame from the middle decodes. macOS only. Usage: swift scripts/demo/avprobe.swift <movie>
import AVFoundation
import Foundation

let path = CommandLine.arguments[1]
let asset = AVURLAsset(url: URL(fileURLWithPath: path))
var out: [String: Any] = ["file": path]
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let duration = try await asset.load(.duration)
    let playable = try await asset.load(.isPlayable)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    out["seconds"] = duration.seconds
    out["playable"] = playable
    out["videoTracks"] = tracks.count
    if let t = tracks.first {
      out["nominalFrameRate"] = try await t.load(.nominalFrameRate)
      let size = try await t.load(.naturalSize)
      out["width"] = size.width
      out["height"] = size.height
    }
    let gen = AVAssetImageGenerator(asset: asset)
    let (image, _) = try await gen.image(at: CMTime(seconds: duration.seconds / 2, preferredTimescale: 600))
    out["decodedFrame"] = "\(image.width)x\(image.height)"
  } catch {
    out["error"] = "\(error)"
  }
  sem.signal()
}
sem.wait()
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
