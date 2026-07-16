export type OrderStatus = "OPEN" | "PAID" | "CANCELLED";
export type ItemStatus = "ORDERED" | "PREPARING" | "PREPARED" | "SERVED" | "CANCELLED";

export const categories = ["Small Plates", "From the Fire", "Desserts", "Drinks"] as const;

export const menuItems = [
  {
    id: "item-tomatoes",
    category: "Small Plates",
    name: "Charred Tomatoes",
    description: "Whipped feta, basil oil, sourdough crunch",
    price: 16,
    image: "menu/charred-tomatoes.png",
    color: "#D86F4A",
  },
  {
    id: "item-focaccia",
    category: "Small Plates",
    name: "Rosemary Focaccia",
    description: "Sea salt, cultured butter, smoked honey",
    price: 11,
    image: "menu/rosemary-focaccia.png",
    color: "#C78C4A",
  },
  {
    id: "item-seabass",
    category: "From the Fire",
    name: "Grilled Sea Bass",
    description: "Spring peas, asparagus, lemon beurre blanc",
    price: 34,
    image: "menu/grilled-sea-bass.png",
    color: "#769776",
  },
  {
    id: "item-rigatoni",
    category: "From the Fire",
    name: "Truffle Rigatoni",
    description: "Wild mushrooms, pecorino, black truffle",
    price: 28,
    image: "menu/truffle-rigatoni.png",
    color: "#9B7354",
  },
  {
    id: "item-citrus",
    category: "Desserts",
    name: "Pistachio Citrus",
    description: "Olive oil cake, orange curd, pistachio cream",
    price: 13,
    image: "menu/pistachio-citrus.png",
    color: "#D3A64E",
  },
  {
    id: "item-spritz",
    category: "Drinks",
    name: "Blood Orange Spritz",
    description: "Blood orange, rosemary, sparkling water",
    price: 12,
    image: "menu/blood-orange-spritz.png",
    color: "#CE654E",
  },
] as const;

export const users = [
  { id: "user-clara", name: "Clara Mendes", email: "clara@example.com", orders: 8 },
  { id: "user-noah", name: "Noah Williams", email: "noah@example.com", orders: 3 },
  { id: "user-maya", name: "Maya Chen", email: "maya@example.com", orders: 12 },
  { id: "user-luca", name: "Luca Romano", email: "luca@example.com", orders: 5 },
] as const;

export const tables = [
  { id: 1, seats: 2, status: "AVAILABLE", guest: null, total: null },
  { id: 2, seats: 4, status: "IN USE", guest: "Noah", total: 52 },
  { id: 3, seats: 4, status: "AVAILABLE", guest: null, total: null },
  { id: 4, seats: 6, status: "IN USE", guest: "Maya", total: 118 },
  { id: 5, seats: 2, status: "AVAILABLE", guest: null, total: null },
  { id: 6, seats: 4, status: "IN USE", guest: "Luca", total: 76 },
  { id: 7, seats: 4, status: "IN USE", guest: "Clara", total: 74 },
  { id: 8, seats: 8, status: "IN USE", guest: "Sofia", total: 164 },
  { id: 9, seats: 2, status: "AVAILABLE", guest: null, total: null },
  { id: 10, seats: 4, status: "AVAILABLE", guest: null, total: null },
  { id: 11, seats: 6, status: "IN USE", guest: "Ethan", total: 93 },
  { id: 12, seats: 4, status: "AVAILABLE", guest: null, total: null },
] as const;

export const activeOrder = {
  id: "#1048",
  user: users[0],
  table: 7,
  status: "OPEN" as OrderStatus,
  openedAt: "7:42 PM",
  items: [
    { id: "rel-1", item: menuItems[0], quantity: 1, status: "SERVED" as ItemStatus },
    { id: "rel-2", item: menuItems[2], quantity: 1, status: "PREPARING" as ItemStatus },
    { id: "rel-3", item: menuItems[5], quantity: 2, status: "PREPARED" as ItemStatus },
  ],
  total: 74,
};

export const orders = [
  activeOrder,
  {
    id: "#1047",
    user: users[2],
    table: 4,
    status: "OPEN" as OrderStatus,
    total: 118,
    openedAt: "7:36 PM",
  },
  {
    id: "#1046",
    user: users[1],
    table: 2,
    status: "OPEN" as OrderStatus,
    total: 52,
    openedAt: "7:28 PM",
  },
  {
    id: "#1045",
    user: users[3],
    table: 6,
    status: "OPEN" as OrderStatus,
    total: 76,
    openedAt: "7:14 PM",
  },
  {
    id: "#1044",
    user: users[0],
    table: 3,
    status: "PAID" as OrderStatus,
    total: 86,
    openedAt: "6:32 PM",
  },
  {
    id: "#1043",
    user: users[2],
    table: 9,
    status: "CANCELLED" as OrderStatus,
    total: 0,
    openedAt: "6:18 PM",
  },
] as const;

export const kitchenQueue = [
  {
    id: "q1",
    order: "#1048",
    table: 7,
    item: "Grilled Sea Bass",
    status: "PREPARING" as ItemStatus,
    elapsed: "8m",
  },
  {
    id: "q2",
    order: "#1047",
    table: 4,
    item: "Truffle Rigatoni",
    status: "ORDERED" as ItemStatus,
    elapsed: "3m",
  },
  {
    id: "q3",
    order: "#1047",
    table: 4,
    item: "Charred Tomatoes",
    status: "PREPARED" as ItemStatus,
    elapsed: "12m",
  },
  {
    id: "q4",
    order: "#1046",
    table: 2,
    item: "Rosemary Focaccia",
    status: "SERVED" as ItemStatus,
    elapsed: "16m",
  },
  {
    id: "q5",
    order: "#1045",
    table: 6,
    item: "Pistachio Citrus",
    status: "ORDERED" as ItemStatus,
    elapsed: "2m",
  },
  {
    id: "q6",
    order: "#1048",
    table: 7,
    item: "Blood Orange Spritz ×2",
    status: "PREPARED" as ItemStatus,
    elapsed: "6m",
  },
  {
    id: "q7",
    order: "#1042",
    table: 5,
    item: "Grilled Sea Bass",
    status: "CANCELLED" as ItemStatus,
    elapsed: "—",
  },
] as const;

export const pastOrders = [
  { id: "#1044", date: "Today, 6:32 PM", table: 3, status: "PAID" as OrderStatus, total: 86 },
  { id: "#0982", date: "Jun 28, 8:14 PM", table: 11, status: "PAID" as OrderStatus, total: 122 },
  { id: "#0913", date: "Jun 11, 7:46 PM", table: 4, status: "CANCELLED" as OrderStatus, total: 0 },
] as const;
