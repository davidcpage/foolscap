// File extension → a kind label + a palette colour KEY (the same keys NodeRecord.color uses, mapped to
// swatches by the `c-<key>` CSS the spike copies from app/). Colouring cards by kind turns the board into
// a legible map of the folder — markdown yellow, code blue, data green — which is most of what sells
// "the filesystem, on the canvas". Kind/colour are derived on the CLIENT so the Node middleware stays
// a dumb file server (it returns only path + content).

export interface FileKind {
  kind: string;
  color: string; // a key in NOTE_COLORS / the c-<key> CSS classes
}

const BY_EXT: Record<string, FileKind> = {
  ".md": { kind: "md", color: "yellow" },
  ".markdown": { kind: "md", color: "yellow" },
  ".txt": { kind: "txt", color: "yellow" },
  ".ts": { kind: "ts", color: "blue" },
  ".tsx": { kind: "tsx", color: "blue" },
  ".js": { kind: "js", color: "blue" },
  ".jsx": { kind: "jsx", color: "blue" },
  ".mjs": { kind: "js", color: "blue" },
  ".cjs": { kind: "js", color: "blue" },
  ".py": { kind: "py", color: "blue" },
  ".sh": { kind: "sh", color: "blue" },
  ".json": { kind: "json", color: "green" },
  ".yaml": { kind: "yaml", color: "green" },
  ".yml": { kind: "yaml", color: "green" },
  ".toml": { kind: "toml", color: "green" },
  ".css": { kind: "css", color: "pink" },
  ".html": { kind: "html", color: "orange" },
  ".ipynb": { kind: "ipynb", color: "orange" }, // Jupyter notebooks open as the read-only ipynb card
};

const OTHER: FileKind = { kind: "file", color: "purple" };

export function fileKind(filePath: string): FileKind {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return BY_EXT[ext] ?? OTHER;
}

export function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}
