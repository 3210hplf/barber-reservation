// SafeAreaTopScrim: top safe-area overlay strip.
//
// Renders a fixed strip across the top of the viewport, as tall as the
// device's top safe-area inset (notch / status bar), painted with the
// given background color so scrolled content does not show through it.

export function SafeAreaTopScrim({
  backgroundColor,
}: {
  backgroundColor: string;
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "env(safe-area-inset-top)",
        backgroundColor,
        zIndex: 50,
        pointerEvents: "none",
      }}
    />
  );
}
