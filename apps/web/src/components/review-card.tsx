import { ReviewPanel, type ReviewPanelProps } from "./review-card-panel";

export type ReviewCardProps = ReviewPanelProps;

/**
 * The client's decision point on a milestone in review or needs_client, on the contract rail. The caller passes the
 * review window's length (core reviewWindowSeconds of the contract) for the countdown ring; the interactive part is
 * ReviewPanel.
 */
export function ReviewCard(props: ReviewCardProps) {
  // On the rail the station's own gap spaces the card; the panel's top margin would add a second one.
  return (
    <div className="*:mt-0!">
      <ReviewPanel {...props} />
    </div>
  );
}
