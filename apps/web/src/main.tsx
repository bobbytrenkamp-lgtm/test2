import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import './styles.css';
import { SessionProvider } from './session.js';
import { Shell } from './pages/Shell.js';
import { DashboardPage, AuditPage, JobsPage, PortfoliosPage } from './pages/Overview.js';
import { FundsPage } from './pages/Funds.js';
import { TasksPage } from './pages/Tasks.js';
import { SecurityPage } from './pages/Security.js';
import { OrganizationPage } from './pages/Organization.js';
import { AcceptInvitationPage } from './pages/AcceptInvitation.js';
import { PropertiesPage } from './pages/Properties.js';
import { PropertyDetailPage } from './pages/PropertyDetail.js';
import { ModelWorkspace } from './pages/ModelWorkspace.js';
import { CashFlowTab } from './pages/CashFlowTab.js';
import { RentRollTab } from './pages/RentRollTab.js';
import { AssumptionsTab } from './pages/AssumptionsTab.js';
import { ReturnsTab } from './pages/ReturnsTab.js';
import { HealthTab } from './pages/HealthTab.js';
import { ICSummaryTab } from './pages/ICSummaryTab.js';
import { ProvenanceTab } from './pages/ProvenanceTab.js';
import { AssumptionImportTab } from './pages/AssumptionImportTab.js';
import { ScenariosTab } from './pages/ScenariosTab.js';
import { BudgetsTab } from './pages/BudgetsTab.js';
import {
  ImportsTab,
  ReportsTab,
  ReviewTab,
  ValidationTab,
  VersionsTab,
} from './pages/SupportTabs.js';

const container = document.getElementById('root');
if (!container) throw new Error('The application root element is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <Router>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<DashboardPage />} />
            <Route path="properties" element={<PropertiesPage />} />
            <Route path="properties/:propertyId" element={<PropertyDetailPage />} />
            <Route path="portfolios" element={<PortfoliosPage />} />
            <Route path="funds" element={<FundsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="organization" element={<OrganizationPage />} />
            <Route path="accept-invitation" element={<AcceptInvitationPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="models/:modelId" element={<ModelWorkspace />}>
              <Route index element={<CashFlowTab />} />
              <Route path="rent-roll" element={<RentRollTab />} />
              <Route path="assumptions" element={<AssumptionsTab />} />
              <Route path="returns" element={<ReturnsTab />} />
              <Route path="health" element={<HealthTab />} />
              <Route path="provenance" element={<ProvenanceTab />} />
              <Route path="assumption-import" element={<AssumptionImportTab />} />
              <Route path="scenarios" element={<ScenariosTab />} />
              <Route path="budgets" element={<BudgetsTab />} />
              <Route path="validation" element={<ValidationTab />} />
              <Route path="reports" element={<ReportsTab />} />
              <Route path="imports" element={<ImportsTab />} />
              <Route path="versions" element={<VersionsTab />} />
              <Route path="review" element={<ReviewTab />} />
              <Route path="ic-summary" element={<ICSummaryTab />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Router>
    </SessionProvider>
  </StrictMode>,
);
