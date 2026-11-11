# Math Board icon

`MathBoard.png` is the approved source artwork; `MathBoard.icns` is its macOS icon set (16–1024 pixels). Both are distributed under this repository's MIT license.

Created with the built-in image generation tool, then refined with this direction: smaller centered pi (about 45% of the tile width), muted warm light-gray chalk, faint chalk grain, smooth matte charcoal rounded square, no chalk stick or dust, transparent outside. Approved by the project owner on 2026-11-11.

To regenerate the icon set after changing the PNG, create a temporary `MathBoard.iconset`, use `sips` to make `icon_16x16.png`, `icon_32x32.png`, `icon_128x128.png`, `icon_256x256.png`, `icon_512x512.png` plus each `@2x` size, then run `iconutil -c icns MathBoard.iconset -o app/assets/MathBoard.icns`.
