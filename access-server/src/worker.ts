// The Worker's entry. Workers treat every export of the entry module as a
// handler, so it exports only that; the server itself is api.ts.

import { handle, type Env } from "./api.js";

export default { fetch: (req: Request, env: Env) => handle(req, env) };
