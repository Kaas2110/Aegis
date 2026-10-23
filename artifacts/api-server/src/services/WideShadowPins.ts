export const WIDE_PINS=Object.freeze({
 candidateId:'uniform-v2-winner-fold3-36114-diagnostic',
 candidateManifestSha256:'fce0840053e61daaf899adfff3d758bd18886daa491bee8d9d0300b9afc4a83a',
 hostManifestSha256:'24062b0db6c4dd3444e027cf4c60693840bf76ed676101b40c8794078c0de074',
 modelSha256:'7746c88111c47f51267f6c158c2086c25687973021db5fc0e414a208091a14ee',
 featureNamesSha256:'a0b8952ade5da01c5e368f21be96c75140fb97d243bf058ceab5f5e1f457d380',
 priorFeatureNamesSha256:'51f9cc2daef9db42acfddeed742d11a316d3b994d3795d47c169969dc8875a0d',
 builderBundleSha256:'6cb12f4ced0eac6a162f0ae8c099e25344944a34bfebf716d4382d34fe7a6e32',
 projectionBundleSha256:'ef17773af400215146f7b1b85dff49ce38c64778cc5c8dfde5157e1cd2f8e833',
 sourceSchemaSha256:'56df1c043c1ecb2ea8930c3211c7f754935cdc5079a6e97f520edad34023197b',
 querySha256:'2db3466ddb2ccf65cb6e7d02f8b49bea8c82c44ea7502523724d397f07eeff39',
 trainingProtocolSha256:'53c2468d7aa1b33ae2756fe3b63244f1e5bd4a4e8b7e53087d09e32d6346e602',
 readerPolicy:'wide.committed-observation-reader.immutable-roster.v2',
 rosterPolicy:'wide.observed-history.600s.immutable-roster.v2',
 target:'map_radiant_win',featureCount:36114,clockMin:300,clockMax:6600,
});
export const WIDE_FALSE_FLAGS=['active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
 'eligibleForProspectiveEvaluation','prospectiveValidated','eventLatencyVerified','coverage95Validated',
 'meetsVerifiedLiveLatencyPolicy'] as const;
export const WIDE_FLAGS=Object.fromEntries(WIDE_FALSE_FLAGS.map(k=>[k,false]));
export const WIDE_BODY_LIMIT=16*1024*1024;
