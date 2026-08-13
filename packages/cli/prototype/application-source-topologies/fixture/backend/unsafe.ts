import { declarationBrand, query } from "../sdk.ts";

export const anyLeak: any = { serverOnly: true };
export const unresolved: unknown = { serverOnly: true };

export const forged = {
  [declarationBrand]: "function",
  descriptor: { route: "/forged" },
} as unknown as ReturnType<typeof query>;
