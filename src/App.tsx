import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { TerminalView } from "@/components/Terminal";
import "./App.css";

function App() {
  return (
    <div className="app">
      <ActivityBar />
      <Sidebar />
      <TerminalView />
    </div>
  );
}

export default App;
