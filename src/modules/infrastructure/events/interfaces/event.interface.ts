export interface Event {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly userName: string;
  readonly title?: string;
  readonly timestamp?: string;
}
