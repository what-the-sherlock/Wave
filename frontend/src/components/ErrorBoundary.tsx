import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * An app-root safety net for render-time errors React itself can't
 * recover from. Structured error tracking (Sentry) arrives in Phase 8;
 * for now this is the difference between a blank white screen and a
 * page that tells the user what to do.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Last-resort visibility until Sentry lands in Phase 8.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen gap-4 text-center px-4">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-base-content/60 max-w-sm">
            Please refresh the page. If this keeps happening, let us know.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
