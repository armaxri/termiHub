import { useEffect } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TerminalView } from "@/components/Terminal";
import { PasswordPrompt } from "@/components/PasswordPrompt";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/store/appStore";
import "./App.css";

function App() {
  useKeyboardShortcuts();
  const loadFromBackend = useAppStore((s) => s.loadFromBackend);

  useEffect(() => {
    loadFromBackend();
  }, [loadFromBackend]);

  return (
    <div className="app">
      <div className="app__main">
        <ActivityBar />
        <Sidebar />
        <TerminalView />
      </div>
      <StatusBar />
      <PasswordPrompt />
    </div>
  );
}

export default App;
