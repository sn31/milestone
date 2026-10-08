import { Button, EmptyState, PageHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <main>
      <PageHeader
        eyebrow="404 / no such station"
        title={
          <>
            Off the <em>rail</em>
          </>
        }
        description="This page is not on any contract we know about. Nothing moved; no money was touched."
      />
      <EmptyState
        className="mt-12"
        title="The link may be old, or the contract was reset"
        body="Demo data is reseeded from time to time, which removes contracts created during a session."
        action={<Button href="/" variant="primary">Back to contracts</Button>}
      />
    </main>
  );
}
