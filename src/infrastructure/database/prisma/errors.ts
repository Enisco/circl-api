export const PrismaError = {
  // Common (Connection/Schema) Errors
  AuthenticationFailed: 'P1000', // Authentication failed against database server :contentReference[oaicite:1]{index=1}
  ConnectionFailed: 'P1001', // Can't reach database server :contentReference[oaicite:2]{index=2}
  ConnectionTimedOut: 'P1002', // Database server was reached but timed out :contentReference[oaicite:3]{index=3}
  DatabaseDoesNotExist: 'P1003', // Database does not exist :contentReference[oaicite:4]{index=4}
  OperationTimedOut: 'P1008', // Operations timed out :contentReference[oaicite:5]{index=5}
  DatabaseAlreadyExists: 'P1009', // Database already exists :contentReference[oaicite:6]{index=6}
  AccessDenied: 'P1010', // User denied access on the database :contentReference[oaicite:7]{index=7}
  TlsConnectionError: 'P1011', // Error opening a TLS connection :contentReference[oaicite:8]{index=8}
  SchemaValidationError: 'P1012', // Schema invalid in current Prisma version :contentReference[oaicite:9]{index=9}
  InvalidDatabaseString: 'P1013', // The provided database string is invalid :contentReference[oaicite:10]{index=10}
  UnderlyingKindDoesNotExist: 'P1014', // Underlying connector for a model does not exist :contentReference[oaicite:11]{index=11}
  UnsupportedFeatureForDatabaseVersion: 'P1015', // Prisma schema uses features not supported by DB version :contentReference[oaicite:12]{index=12}
  IncorrectRawQueryParameters: 'P1016', // Raw query had incorrect number of parameters :contentReference[oaicite:13]{index=13}
  ServerClosedConnection: 'P1017', // Server has closed the connection :contentReference[oaicite:14]{index=14}

  // Prisma Client (Query Engine) Errors
  ValueTooLongForColumn: 'P2000', // Provided value too long for column type :contentReference[oaicite:15]{index=15}
  RecordNotFound: 'P2001', // Record searched for in `where` condition does not exist :contentReference[oaicite:16]{index=16}
  UniqueConstraintViolation: 'P2002', // Unique constraint failed :contentReference[oaicite:17]{index=17}
  ForeignKeyConstraintViolation: 'P2003', // Foreign key constraint failed :contentReference[oaicite:18]{index=18}
  DatabaseConstraintFailed: 'P2004', // A database constraint failed :contentReference[oaicite:19]{index=19}
  InvalidFieldValue: 'P2005', // Value stored in DB is invalid for field’s type :contentReference[oaicite:20]{index=20}
  InvalidFieldValueProvided: 'P2006', // Provided value for a model field is not valid :contentReference[oaicite:21]{index=21}
  DataValidationError: 'P2007', // Data validation error from DB :contentReference[oaicite:22]{index=22}
  QueryParsingError: 'P2008', // Failed to parse the query :contentReference[oaicite:23]{index=23}
  QueryValidationError: 'P2009', // Failed to validate the query :contentReference[oaicite:24]{index=24}
  RawQueryFailed: 'P2010', // Raw query failed :contentReference[oaicite:25]{index=25}
  NullConstraintViolation: 'P2011', // Null constraint violation :contentReference[oaicite:26]{index=26}
  MissingRequiredValue: 'P2012', // Missing a required value :contentReference[oaicite:27]{index=27}
  MissingRequiredArgument: 'P2013', // Missing a required argument for a field :contentReference[oaicite:28]{index=28}
  RequiredRelationViolation: 'P2014', // Change would violate a required relation :contentReference[oaicite:29]{index=29}
  RelatedRecordNotFound: 'P2015', // A related record could not be found :contentReference[oaicite:30]{index=30}
  QueryInterpretationError: 'P2016', // Query interpretation error :contentReference[oaicite:31]{index=31}
  RecordsNotConnectedForRelation: 'P2017', // Records for a relation are not connected :contentReference[oaicite:32]{index=32}
  RequiredConnectedRecordsNotFound: 'P2018', // Required connected records were not found :contentReference[oaicite:33]{index=33}
  InputError: 'P2019', // Input error :contentReference[oaicite:34]{index=34}
  ValueOutOfRange: 'P2020', // Value out of range for the type :contentReference[oaicite:35]{index=35}
  TableDoesNotExist: 'P2021', // The table does not exist in the current database :contentReference[oaicite:36]{index=36}
  ColumnDoesNotExist: 'P2022', // The column does not exist in the current database :contentReference[oaicite:37]{index=37}
  InconsistentColumnData: 'P2023', // Inconsistent column data :contentReference[oaicite:38]{index=38}
  ConnectionPoolTimeout: 'P2024', // Timed out fetching a new connection from the pool :contentReference[oaicite:39]{index=39}
  RequiredRecordNotFound: 'P2025', // Operation failed because required record wasn’t found :contentReference[oaicite:40]{index=40}
  UnsupportedFeature: 'P2026', // Current DB provider doesn’t support a feature used by the query :contentReference[oaicite:41]{index=41}
  MultipleDatabaseErrors: 'P2027', // Multiple errors occurred on the database during query execution :contentReference[oaicite:42]{index=42}
  TransactionApiError: 'P2028', // Transaction API error :contentReference[oaicite:43]{index=43}
  QueryParameterLimitExceeded: 'P2029', // Query parameter limit exceeded :contentReference[oaicite:44]{index=44}
  FulltextIndexNotFound: 'P2030', // Cannot find a fulltext index to use for the search :contentReference[oaicite:45]{index=45}
  MongoDbReplicaSetRequired: 'P2031', // MongoDB needs to be run as a replica set for transactions :contentReference[oaicite:46]{index=46}
  IntegerOutOfRange: 'P2033', // A number in the query does not fit into a 64-bit integer :contentReference[oaicite:47]{index=47}
  TransactionWriteConflict: 'P2034', // Transaction failed due to a write conflict or deadlock :contentReference[oaicite:48]{index=48}
  AssertionViolation: 'P2035', // Assertion violation on the database :contentReference[oaicite:49]{index=49}
  ExternalConnectorError: 'P2036', // Error in external connector :contentReference[oaicite:50]{index=50}
  TooManyDatabaseConnections: 'P2037', // Too many database connections opened :contentReference[oaicite:51]{index=51}

  // Prisma Migrate (Schema Engine) Errors
  MigrationFailedCreateDatabase: 'P3000', // Failed to create database :contentReference[oaicite:52]{index=52}
  MigrationPossibleDestructiveChanges: 'P3001', // Migration possible with destructive changes :contentReference[oaicite:53]{index=53}
  MigrationRolledBack: 'P3002', // Migration was rolled back :contentReference[oaicite:54]{index=54}
  MigrationFormatChanged: 'P3003', // Format of migrations changed :contentReference[oaicite:55]{index=55}
  MigrationOnSystemDatabase: 'P3004', // Attempted to alter a system database :contentReference[oaicite:56]{index=56}
  DatabaseSchemaNotEmpty: 'P3005', // Database schema is not empty :contentReference[oaicite:57]{index=57}
  MigrationFailedShadowDatabase: 'P3006', // Migration failed to apply to the shadow database :contentReference[oaicite:58]{index=58}
  PreviewFeaturesNotAllowed: 'P3007', // Some requested preview features are not allowed :contentReference[oaicite:59]{index=59}
  MigrationAlreadyApplied: 'P3008', // Migration is already recorded as applied :contentReference[oaicite:60]{index=60}
  MigrateFoundFailedMigrations: 'P3009', // Migrate found failed migrations in the target database :contentReference[oaicite:61]{index=61}
  MigrationNameTooLong: 'P3010', // Migration name is too long :contentReference[oaicite:62]{index=62}
  MigrationCannotRollbackNeverApplied: 'P3011', // Migration cannot be rolled back because it was never applied :contentReference[oaicite:63]{index=63}
  MigrationCannotRollbackNotFailed: 'P3012', // Migration cannot be rolled back because it is not in a failed state :contentReference[oaicite:64]{index=64}
  ProviderArraysNotSupported: 'P3013', // Datasource provider arrays no longer supported :contentReference[oaicite:65]{index=65}
  ShadowDatabaseCreationFailed: 'P3014', // Prisma Migrate could not create the shadow database :contentReference[oaicite:66]{index=66}
  MigrationFileNotFound: 'P3015', // Could not find the migration file :contentReference[oaicite:67]{index=67}
  FallbackResetFailed: 'P3016', // Fallback method for database resets failed :contentReference[oaicite:68]{index=68}
  MigrationNotFound: 'P3017', // Migration could not be found :contentReference[oaicite:69]{index=69}
  MigrationFailedToApply: 'P3018', // A migration failed to apply :contentReference[oaicite:70]{index=70}

  // Prisma Cloud / Rate Limiting
  TooManyRequests: 'P5011', // Too many requests (rate limited) :contentReference[oaicite:71]{index=71}
} as const;
