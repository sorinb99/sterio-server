import AppKit

// The server's icon is the Sterio icon with its colours inverted, so the
// two apps are easy to tell apart in the Dock and in Launchpad.
//   invert-icon <source.png> <output.png>
let arguments = CommandLine.arguments
guard arguments.count == 3, let source = NSImage(contentsOfFile: arguments[1]),
      let image = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: invert-icon <source.png> <output.png>\n".data(using: .utf8)!)
  exit(1)
}
let width = image.width, height = image.height
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let pixels = context.data?.bindMemory(to: UInt8.self, capacity: width * height * 4) else { exit(1) }
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
// With premultiplied alpha, alpha - c inverts the colour and keeps the
// transparent rounded corners transparent.
for index in stride(from: 0, to: width * height * 4, by: 4) {
  let alpha = pixels[index + 3]
  for channel in 0..<3 { pixels[index + channel] = alpha &- min(pixels[index + channel], alpha) }
}
guard let inverted = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: inverted).representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: arguments[2]))
