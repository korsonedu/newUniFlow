import Foundation
import AppKit
import CoreGraphics

let args = CommandLine.arguments
if args.count < 3 {
    print("Usage: swift process_icon.swift <source_path> <output_path>")
    exit(1)
}

let sourcePath = args[1]
let outputPath = args[2]

guard let sourceImage = NSImage(contentsOfFile: sourcePath) else {
    print("Error: Could not load source image at \(sourcePath)")
    exit(1)
}

let canvasSize = NSSize(width: 1024, height: 1024)
let targetSize = NSSize(width: 824, height: 824)
let x = (canvasSize.width - targetSize.width) / 2
let y = (canvasSize.height - targetSize.height) / 2

let outputImage = NSImage(size: canvasSize)
outputImage.lockFocus()

let context = NSGraphicsContext.current?.cgContext
context?.clear(CGRect(origin: .zero, size: canvasSize))

sourceImage.draw(in: NSRect(x: x, y: y, width: targetSize.width, height: targetSize.height),
                 from: .zero,
                 operation: .sourceOver,
                 fraction: 1.0)

outputImage.unlockFocus()

guard let tiffData = outputImage.tiffRepresentation,
      let bitmapImage = NSBitmapImageRep(data: tiffData),
      let pngData = bitmapImage.representation(using: .png, properties: [:]) else {
    print("Error: Could not convert to PNG")
    exit(1)
}

do {
    try pngData.write(to: URL(fileURLWithPath: outputPath))
    print("Successfully processed icon: \(outputPath)")
} catch {
    print("Error: \(error)")
    exit(1)
}
