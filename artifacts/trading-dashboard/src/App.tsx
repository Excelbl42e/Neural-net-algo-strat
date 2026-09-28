import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/app-layout";
import { AuthGate } from "@/components/auth-gate";

import { useTheme } from "@/hooks/use-theme";

import Dashboard from "@/pages/dashboard";
import Signals from "@/pages/signals";
import Strategy from "@/pages/strategy";
import Accounts from "@/pages/accounts";
import Trades from "@/pages/trades";
import Reports from "@/pages/reports";
import Brokers from "@/pages/brokers";
import Configuration from "@/pages/configuration";
import Analysis from "@/pages/analysis";
import Chart from "@/pages/chart";
import Education from "@/pages/education";
import Journal from "@/pages/journal";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/signals" component={Signals} />
        <Route path="/chart" component={Chart} />
        <Route path="/strategy" component={Strategy} />
        <Route path="/brokers" component={Brokers} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/trades" component={Trades} />
        <Route path="/reports" component={Reports} />
        <Route path="/analysis" component={Analysis} />
        <Route path="/education" component={Education} />
        <Route path="/journal" component={Journal} />
        <Route path="/configuration" component={Configuration} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  useTheme(); // Initializes dark mode
  
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </AuthGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
