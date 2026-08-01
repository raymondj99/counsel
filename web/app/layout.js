import "./globals.css";

export const metadata = {
  title: "Counsel",
  description: "Two-person voice call with a live transcript",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
