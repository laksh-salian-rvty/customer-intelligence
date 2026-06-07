import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="app-error">
        <div>
          <h1>Something went wrong.</h1>
          <p>The app hit a saved-state issue. Resetting local chat history usually fixes this.</p>
          <button
            onClick={() => {
              localStorage.removeItem("revvity-agent-hub-sessions");
              window.location.reload();
            }}
            type="button"
          >
            Reset chats and reload
          </button>
        </div>
      </main>
    );
  }
}
