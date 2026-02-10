import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { TerminalView } from "@/components/Terminal";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import "./App.css";

function App() {
  useKeyboardShortcuts();

  return (
    <div className="app">
      <ActivityBar />
      <Sidebar />
      <TerminalView />
    </div>
  );
}

export default App;
