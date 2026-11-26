import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { inject } from '@angular/core';

/** 24-unit stroke icons, drawn for Quarry. */
const P: Record<string, string> = {
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  playLine: '<path d="M5 4.5v15l10-7.5z"/><path d="M19 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  view: '<rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke-dasharray="3 2.2"/><path d="M3.5 9.5h17"/>',
  fn: '<path d="M14.5 4.5c-2.5 0-3.5 1.5-3.5 4v11"/><path d="M8 10.5h6"/><path d="M15 14l4 5M19 14l-4 5"/>',
  proc: '<path d="M8 4.5l-4 7.5 4 7.5M16 4.5l4 7.5-4 7.5"/><path d="M13.5 6l-3 12"/>',
  bolt: '<path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  fk: '<path d="M10 14a4 4 0 0 1 0-5.6l2.5-2.5a4 4 0 0 1 5.6 5.6l-1.3 1.3"/><path d="M14 10a4 4 0 0 1 0 5.6l-2.5 2.5a4 4 0 0 1-5.6-5.6l1.3-1.3"/>',
  index: '<path d="M5 6h14M5 12h9M5 18h5"/>',
  col: '<rect x="8.5" y="3.5" width="7" height="17" rx="1.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  edit: '<path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z"/><path d="M14 7l3 3"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>',
  upload: '<path d="M12 15.5v-11M7 9l5-5 5 5M5 19.5h14"/>',
  file: '<path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z"/><path d="M13.5 3.5V8H18"/>',
  save: '<path d="M5 4.5h11l3.5 3.5v11.5h-14.5z"/><path d="M8 4.5v5h7v-5M8 19.5v-6h8v6"/>',
  folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  diagram:
    '<rect x="3" y="3.5" width="7" height="5.5" rx="1.2"/><rect x="14" y="15" width="7" height="5.5" rx="1.2"/><rect x="14" y="3.5" width="7" height="5.5" rx="1.2"/><path d="M10 6.25h4M17.5 9v6"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="1.5"/><rect x="3.5" y="13" width="17" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.6-3.3 3.2-5 6.5-5s5.9 1.7 6.5 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.8.7 3 2.3 3.5 4.7"/>',
  activity: '<path d="M3 12h4l3-7.5 4 15 3-7.5h4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  format: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.5l3 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5"/>',
  unplug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5"/><path d="M4 4l16 16"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  filter: '<path d="M4 5h16l-6 7.5v6l-4 1.5v-7.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  command: '<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H17.5A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5h.01"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  undo: '<path d="M9 14.5L4 9.5l5-5"/><path d="M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  sparkle: '<path d="M12 3.5l1.9 5.2 5.1 1.8-5.1 1.9L12 17.6l-1.9-5.2L5 10.5l5.1-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  send: '<path d="M4.5 12L20 4.5 15.5 20l-3-6.5z"/><path d="M12.5 13.5L20 4.5"/>',
  wand: '<path d="M4 20L15 9M13 7l2-2 4 4-2 2z"/><path d="M5 5.5h3M6.5 4v3M17 15.5h3M18.5 14v3"/>',
};

@Component({
  selector: 'q-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    [attr.width]="size()"
    [attr.height]="size()"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    [innerHTML]="svg()"
  ></svg>`,
  styles: `:host{display:inline-flex;flex:none} svg{display:block}`,
})
export class Icon {
  private san = inject(DomSanitizer);
  readonly name = input.required<string>();
  readonly size = input<number>(15);
  readonly svg = computed(() => this.san.bypassSecurityTrustHtml(P[this.name()] ?? ''));
}
