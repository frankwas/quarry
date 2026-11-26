import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  untracked,
  viewChild,
  AfterViewInit,
} from '@angular/core';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { MySQL, sql, SQLNamespace } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { SettingsService } from '../core/settings.service';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--syn-func)' },
  { tag: [t.typeName], color: 'var(--syn-type)' },
  { tag: [t.special(t.name)], color: 'var(--syn-ident)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', background: 'var(--panel)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { background: 'var(--panel)', color: 'var(--muted)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--hover) 55%, transparent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'var(--sel-strong) !important' },
  '.cm-selectionMatch': { background: 'var(--sel)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-matchingBracket': { background: 'var(--sel)', outline: '1px solid var(--sel-strong)' },
  '.cm-tooltip': { background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: '8px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 6px !important', lineHeight: '1.7' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionIcon': { opacity: '0.7' },
  '.cm-panels': { background: 'var(--panel-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' },
  '.cm-searchMatch': { background: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-running-stmt': { background: 'color-mix(in srgb, var(--accent-soft) 70%, transparent)' },
});

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value ? Decoration.set([Decoration.mark({ class: 'cm-running-stmt' }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface EditorCommand {
  key: string;
  run: () => void;
}

@Component({
  selector: 'q-sql-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="host"></div>`,
  styles: `:host{display:block;height:100%;min-height:0;overflow:hidden} .host{height:100%}`,
})
export class SqlEditor implements AfterViewInit, OnDestroy {
  private settings = inject(SettingsService);
  readonly value = input<string>('');
  readonly schema = input<SQLNamespace>({});
  readonly defaultSchema = input<string | null>(null);
  readonly placeholder = input<string>('');
  readonly commands = input<EditorCommand[]>([]);
  readonly readOnly = input<boolean>(false);
  readonly changed = output<string>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  view!: EditorView;
  private lang = new Compartment();
  private keys = new Compartment();
  private ro = new Compartment();
  private fontSize = new Compartment();

  constructor() {
    effect(() => {
      const s = this.schema();
      const d = this.defaultSchema();
      if (this.view) this.view.dispatch({ effects: this.lang.reconfigure(this.langExt(s, d)) });
    });
    effect(() => {
      const c = this.commands();
      if (this.view) this.view.dispatch({ effects: this.keys.reconfigure(this.keyExt(c)) });
    });
    effect(() => {
      const r = this.readOnly();
      if (this.view) this.view.dispatch({ effects: this.ro.reconfigure(EditorState.readOnly.of(r)) });
    });
    effect(() => {
      const size = this.settings.s().editorFontSize;
      if (this.view) this.view.dispatch({ effects: this.fontSize.reconfigure(this.fontExt(size)) });
    });
    effect(() => {
      const v = this.value();
      untracked(() => {
        if (this.view && v !== this.view.state.doc.toString()) this.setText(v);
      });
    });
  }

  private langExt(schema: SQLNamespace, def: string | null) {
    return sql({ dialect: MySQL, schema, defaultSchema: def ?? undefined, upperCaseKeywords: true });
  }

  private keyExt(cmds: EditorCommand[]) {
    return Prec.highest(keymap.of(cmds.map((c) => ({ key: c.key, run: () => (c.run(), true), preventDefault: true }))));
  }

  private fontExt(size: number) {
    return EditorView.theme({ '.cm-scroller': { fontSize: `${size}px` } });
  }

  ngAfterViewInit() {
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          this.keys.of(this.keyExt(this.commands())),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          autocompletion({ activateOnTyping: true, icons: true }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
            { key: 'Mod-/', run: toggleComment },
            { key: 'Ctrl-Space', run: startCompletion },
          ]),
          this.lang.of(this.langExt(this.schema(), this.defaultSchema())),
          this.ro.of(EditorState.readOnly.of(this.readOnly())),
          this.fontSize.of(this.fontExt(this.settings.s().editorFontSize)),
          syntaxHighlighting(highlight),
          theme,
          flashField,
          cmPlaceholder(this.placeholder()),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.changed.emit(u.state.doc.toString());
          }),
        ],
      }),
    });
  }

  ngOnDestroy() {
    this.view?.destroy();
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  setText(v: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } });
  }

  selection(): { text: string; from: number; to: number } {
    const r = this.view.state.selection.main;
    return { text: this.view.state.sliceDoc(r.from, r.to), from: r.from, to: r.to };
  }

  cursor(): number {
    return this.view.state.selection.main.head;
  }

  replaceRange(from: number, to: number, text: string) {
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length } });
  }

  insertAtCursor(text: string) {
    const r = this.view.state.selection.main;
    this.view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
    this.view.focus();
  }

  flash(from: number, to: number) {
    this.view.dispatch({ effects: flashEffect.of({ from, to }) });
    setTimeout(() => this.view?.dispatch({ effects: flashEffect.of(null) }), 450);
  }

  focus() {
    this.view?.focus();
  }
}
