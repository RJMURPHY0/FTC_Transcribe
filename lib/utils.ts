import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class lists, resolving conflicts (last wins). Same helper the
 *  Contacts app uses, so ported shadcn-style primitives behave identically. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
