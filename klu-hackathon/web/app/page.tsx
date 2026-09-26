import { redirect } from "next/navigation";

// Middleware already bounces signed-out visitors to /login, so the root is just a hop.
export default function Home() {
  redirect("/dashboard");
}
