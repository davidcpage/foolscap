// Hand-written surface types for the vendored lit-html.js (3.3.3, BSD-3) — just the four exports
// the host and templates use. The vendored file is the single substrate copy: templates import it
// by URL (/vendor/lit-html.js) and the host imports the same file relatively, so dev-server module
// identity unifies them and TemplateResults render with the engine that made them.
export interface TemplateResult {
  ["_$litType$"]: number;
  strings: TemplateStringsArray;
  values: unknown[];
}
export declare function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult;
export declare function svg(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult;
export declare function render(value: unknown, container: HTMLElement): unknown;
export declare const nothing: symbol;
