/**
 * A DOM stand-in for the save surfaces (receipt row, save panel): enough of
 * Obsidian's HTMLElement helpers to render, click, type and query. Tests run in
 * node, so there is no real document.
 */
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };

export class FakeEl {
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  text = "";
  value = "";
  tabIndex = -1;
  hidden = false;
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();

  constructor(
    readonly tag = "div",
    o: Opts = {},
  ) {
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) this.classes.add(c);
    this.text = o.text ?? "";
    Object.assign(this.attrs, o.attr ?? {});
  }
  createDiv(o: Opts = {}): FakeEl {
    return this.appendChild(new FakeEl("div", o));
  }
  createSpan(o: Opts = {}): FakeEl {
    return this.appendChild(new FakeEl("span", o));
  }
  createEl(tag: string, o: Opts = {}): FakeEl {
    return this.appendChild(new FakeEl(tag, o));
  }
  appendChild(el: FakeEl): FakeEl {
    el.remove();
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  remove(): void {
    const p = this.parentElement;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
  empty(): void {
    for (const c of [...this.children]) c.remove();
    this.text = "";
  }
  addClass(c: string): void {
    this.classes.add(c);
  }
  removeClass(c: string): void {
    this.classes.delete(c);
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c);
    else this.classes.delete(c);
  }
  hasClass(c: string): boolean {
    return this.classes.has(c);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  show(): void {
    this.hidden = false;
  }
  hide(): void {
    this.hidden = true;
  }
  focus(): void {}
  contains(el: unknown): boolean {
    return el === this || this.children.some((c) => c.contains(el));
  }
  addEventListener(type: string, h: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }
  removeEventListener(): void {}
  fire(type: string, e: Record<string, unknown> = {}): void {
    for (const h of this.handlers.get(type) ?? []) h({ preventDefault: () => {}, stopPropagation: () => {}, target: this, ...e });
  }
  click(): void {
    this.fire("click");
  }
  /** Type into an input/textarea. */
  input(v: string): void {
    this.value = v;
    this.fire("input");
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): FakeEl[] {
    return this.all().filter((c) => c.classes.has(cls));
  }
  byText(t: string): FakeEl | undefined {
    return this.all().find((c) => c.text === t);
  }
}

export const asEl = (el: FakeEl): HTMLElement => el as unknown as HTMLElement;
