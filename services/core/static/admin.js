// Small progressive enhancements for the admin UI (works without JS too).
document.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.matches("[data-confirm]") && !confirm(t.dataset.confirm)) {
    e.preventDefault();
    return;
  }
  if (t.matches("[data-add-row]")) {
    e.preventDefault();
    const tpl = document.getElementById(t.dataset.addRow);
    const target = document.getElementById(t.dataset.target);
    if (tpl && target) target.appendChild(tpl.content.cloneNode(true));
  }
  if (t.matches("[data-remove-row]")) {
    e.preventDefault();
    t.closest(".editor-row")?.remove();
  }
  if (t.matches("[data-copy]")) {
    e.preventDefault();
    navigator.clipboard?.writeText(t.dataset.copy).then(() => {
      const old = t.textContent;
      t.textContent = "Zkopírováno ✓";
      setTimeout(() => (t.textContent = old), 1500);
    });
  }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === "color") {
    const hex = t.closest(".editor-row")?.querySelector("input[data-hex]");
    if (hex) hex.value = t.value.toUpperCase();
  }
  if (t instanceof HTMLInputElement && t.dataset.hex !== undefined && /^#[0-9a-f]{6}$/i.test(t.value)) {
    const color = t.closest(".editor-row")?.querySelector("input[type=color]");
    if (color) color.value = t.value;
  }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.dataset.autosubmit !== undefined) t.form?.submit();
});
