import { isSimulatorEnabled } from "@/server/simulator/enabled";
import { AppNav } from "./nav";

/**
 * Chrome shared by every operator surface. A route group, so the paths stay
 * `/console`, `/cases`, … — the landing page and `/login` sit outside it and
 * keep their own full-page presentation.
 *
 * Whether the simulator exists is a server question (it is absent in
 * production unless enabled), so it is answered here and handed to the nav.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <AppNav simulatorEnabled={isSimulatorEnabled()} />
      <div className="flex-1">{children}</div>
    </>
  );
}
