// Apply the Momentum Webex theme before first paint to avoid a flash.
// A "#theme=light|dark" hash forces a theme (used by on-device WebViews);
// otherwise the OS colour-scheme preference is followed.
(function initMomentumTheme() {
  const getHashTheme = () => {
    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    if (!raw) return null;
    const theme = new URLSearchParams(raw).get("theme");
    return theme === "light" || theme === "dark" ? theme : null;
  };

  const apply = () => {
    const forcedTheme = getHashTheme();
    const dark = forcedTheme
      ? forcedTheme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const root = document.documentElement;
    root.classList.remove(
      "mds-theme-stable-lightWebex",
      "mds-theme-stable-darkWebex",
    );
    root.classList.add(
      dark ? "mds-theme-stable-darkWebex" : "mds-theme-stable-lightWebex",
    );
    root.style.colorScheme = dark ? "dark" : "light";
  };

  apply();
  window.addEventListener("hashchange", apply);
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (!getHashTheme()) apply();
    });
})();
