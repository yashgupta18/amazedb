import DatabaseWorkspace from "./database-workspace";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <DatabaseWorkspace projectId={projectId} />;
}
