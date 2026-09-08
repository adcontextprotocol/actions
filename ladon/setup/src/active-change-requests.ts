export interface ReviewSummary {
  id: number
  state: string
  body?: string | null
  user?: { login?: string } | null
}

export interface ActiveChangeRequest {
  id: number
  body: string
}

export function selectActiveChangeRequests(
  reviews: ReviewSummary[],
  ladonBotLogin: string,
): ActiveChangeRequest[] {
  return reviews
    .filter(
      (review) =>
        review.user?.login === ladonBotLogin &&
        review.state === 'CHANGES_REQUESTED',
    )
    .map((review) => ({ id: review.id, body: review.body ?? '' }))
}
