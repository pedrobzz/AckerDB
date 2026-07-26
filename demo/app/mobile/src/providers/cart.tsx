import type { MenuItem } from "@demo/ackerdb-codegen/types";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface CartLine {
  readonly item: MenuItem;
  readonly quantity: number;
  readonly note: string;
}

interface CartContextValue {
  readonly lines: readonly CartLine[];
  readonly count: number;
  readonly totalCents: number;
  readonly add: (item: MenuItem) => void;
  readonly setQuantity: (itemId: bigint, quantity: number) => void;
  readonly setNote: (itemId: bigint, note: string) => void;
  readonly remove: (itemId: bigint) => void;
  readonly clear: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { readonly children: ReactNode }) {
  const [lines, setLines] = useState<readonly CartLine[]>([]);

  const add = useCallback((item: MenuItem) => {
    setLines((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      return existing
        ? current.map((line) =>
            line.item.id === item.id
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          )
        : [...current, { item, quantity: 1, note: "" }];
    });
  }, []);

  const setQuantity = useCallback((itemId: bigint, quantity: number) => {
    setLines((current) =>
      quantity < 1
        ? current.filter((line) => line.item.id !== itemId)
        : current.map((line) =>
            line.item.id === itemId ? { ...line, quantity } : line,
          ),
    );
  }, []);

  const setNote = useCallback((itemId: bigint, note: string) => {
    setLines((current) =>
      current.map((line) =>
        line.item.id === itemId ? { ...line, note } : line,
      ),
    );
  }, []);

  const remove = useCallback((itemId: bigint) => {
    setLines((current) => current.filter((line) => line.item.id !== itemId));
  }, []);
  const clear = useCallback(() => setLines([]), []);
  const value = useMemo(
    () => ({
      lines,
      count: lines.reduce((sum, line) => sum + line.quantity, 0),
      totalCents: lines.reduce(
        (sum, line) => sum + line.item.priceCents * line.quantity,
        0,
      ),
      add,
      setQuantity,
      setNote,
      remove,
      clear,
    }),
    [lines, add, setQuantity, setNote, remove, clear],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (value === null) throw new Error("useCart requires CartProvider");
  return value;
}
