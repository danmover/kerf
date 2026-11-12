/** A file name for an app: "Maglev control room" → maglev-control-room. */
export const fileStemOf = (name: string) =>
  name
    .trim()
    .replace(/[^\w\- ]+/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase() || "app";
