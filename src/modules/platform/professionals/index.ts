export * from './professionals.module';
export * from './professionals-core.module';
// The two the admin surface reaches for: §5.16 places a brief by creating the booking the member
// would have created themselves, and §5.17 reads a dispute. `DISPUTE_MEDIA_OWNER` comes with them
// because a dispute's evidence is attached under that owner key and the staff detail serves it.
export * from './services/booking.service';
export * from './services/dispute.service';
export * from './services/category-verification.service';
export * from './services/service-catalogue.service';
export * from './serializers/service.serializer';
