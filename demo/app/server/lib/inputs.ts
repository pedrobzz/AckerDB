import { v } from "@dbzz/server";

export const guestNameInput = v
  .string()
  .min(2)
  .max(80)
  .regex(/^\S(?:.*\S)?$/);

export const emailInput = v
  .string()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

export const categoryNameInput = v
  .string()
  .min(2)
  .max(80)
  .regex(/^\S(?:.*\S)?$/);

export const itemNameInput = v
  .string()
  .min(2)
  .max(80)
  .regex(/^\S(?:.*\S)?$/);

export const descriptionInput = v
  .string()
  .min(1)
  .max(240)
  .regex(/\S/);

export const imagePathInput = v
  .string()
  .min(1)
  .max(500)
  .regex(/\S/);

export const tokenNameInput = v
  .string()
  .min(1)
  .max(80)
  .regex(/^\S(?:.*\S)?$/);
