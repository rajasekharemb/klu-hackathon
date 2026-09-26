import { Suspense } from "react";
import LoginForm from "./LoginForm";

/**
 * The form reads ?next= with useSearchParams, which forces client-side rendering.
 * Next refuses to prerender that unless it sits inside a Suspense boundary, so the
 * boundary lives here and the form stays a separate Client Component.
 */
export default function LoginPage() {
  return (
    <div className="authwrap">
      <Suspense fallback={<div className="authcard">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
