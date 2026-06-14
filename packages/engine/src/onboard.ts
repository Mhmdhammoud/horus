import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { listInvestigations } from '@horus/db';
import { discoverArchitecture, type ArchitectureModel } from './architecture.js';
import { estimateOwnership, type OwnershipEstimate } from './ownership.js';

export interface PastIncident {
  id: string;
  title: string;
  createdAt: string | null;
}

export interface OnboardingGuide {
  area: string | null;
  architecture: ArchitectureModel;
  ownership: OwnershipEstimate | null;
  pastIncidents: PastIncident[];
  summary: string;
}

export async function buildOnboarding(
  input: { area?: string },
  deps: { code: CodeProvider; db: HorusDb; repoPath: string },
): Promise<OnboardingGuide> {
  const architecture = await discoverArchitecture({ code: deps.code, db: deps.db });

  const invs = await listInvestigations(deps.db, 8);
  const pastIncidents: PastIncident[] = invs.map((i) => ({
    id: i.id,
    title: i.title,
    createdAt: i.createdAt != null ? new Date(i.createdAt).toISOString() : null,
  }));

  const ownership =
    input.area != null
      ? await estimateOwnership(input.area, { code: deps.code, repoPath: deps.repoPath })
      : null;

  const largestName = architecture.subsystems[0]?.name ?? 'n/a';
  const summary =
    (input.area != null ? 'Onboarding for "' + input.area + '": ' : 'System onboarding: ') +
    architecture.subsystems.length +
    ' subsystems (largest ' +
    largestName +
    '), ' +
    architecture.asyncBoundaries.length +
    ' async queue boundaries, ' +
    architecture.externalSystems.length +
    ' external systems, ' +
    pastIncidents.length +
    ' past investigation(s) on record.';

  return {
    area: input.area ?? null,
    architecture,
    ownership,
    pastIncidents,
    summary,
  };
}
