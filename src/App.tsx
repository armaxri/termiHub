import { useEffect } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { TerminalView } from "@/components/Terminal";
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
      <ActivityBar />
      <Sidebar />
      <TerminalView />
    </div>
  );
}

export default App;
