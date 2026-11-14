import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

const nunito = Nunito({ variable:'--font-nunito', subsets:['latin'], display:'swap' });

export const metadata: Metadata = {
  title: "Synk",
  description: "Drainage times and sensor insights.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body>{children}</body>
    </html>
  );
}
