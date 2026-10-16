// Set the theme before the first paint, so a light theme never flashes dark.
// The rest of the theme logic is in src/app/theme.ts; this mirrors its rule.
try {
  var pref = JSON.parse(localStorage.getItem("kerf.settings.v1") || "{}").theme;
  var light = pref === "light" || (pref === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  var root = document.documentElement;
  root.dataset.theme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
  if (light) {
    document.querySelector('meta[name="color-scheme"]').setAttribute("content", "light");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#f5f6f9");
  }
} catch (e) {
  /* storage blocked: dark */
}
