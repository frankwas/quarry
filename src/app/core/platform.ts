/** Platform differences that only affect labels: shortcuts already use
 *  Ctrl-or-Cmd everywhere (CodeMirror `Mod`, and ctrlKey || metaKey). */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export const KEYSTORE = IS_MAC ? 'the macOS Keychain' : 'Windows Credential Manager';

/**
 * On macOS, show ⌘ instead of Ctrl in shortcut hints: <kbd> elements, menu
 * hints and "(Ctrl+X)" in titles and placeholders. Elements marked
 * `data-raw-ctrl` (Ctrl+Space autocomplete, which really is Control on a
 * Mac) are left alone, and so is user data in the grid.
 */
export function relabelShortcutsForMac(root: HTMLElement) {
  if (!IS_MAC) return;
  const fixText = (el: Element) => {
    if (el.closest('[data-raw-ctrl]')) return;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE && n.textContent?.includes('Ctrl')) n.textContent = n.textContent.replace(/Ctrl\s?\+?\s?/g, '⌘');
    }
  };
  const fixAttrs = (el: Element) => {
    for (const a of ['title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && /Ctrl\+/.test(v) && !/Ctrl\+Space/.test(v)) el.setAttribute(a, v.replace(/Ctrl\+/g, '⌘'));
    }
  };
  const sweep = (node: Element) => {
    if (node.matches('kbd, .hint')) fixText(node);
    fixAttrs(node);
    node.querySelectorAll('kbd, .hint').forEach(fixText);
    node.querySelectorAll('[title*="Ctrl+"], [placeholder*="Ctrl+"]').forEach(fixAttrs);
  };
  sweep(root);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof Element) fixAttrs(m.target);
      m.addedNodes.forEach((n) => n instanceof Element && sweep(n));
      if (m.type === 'characterData' && m.target.parentElement?.matches('kbd, .hint')) fixText(m.target.parentElement);
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
}
