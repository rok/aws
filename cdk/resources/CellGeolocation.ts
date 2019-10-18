import * as CloudFormation from '@aws-cdk/core'
import * as IAM from '@aws-cdk/aws-iam'
import * as IoT from '@aws-cdk/aws-iot'
import * as DynamoDB from '@aws-cdk/aws-dynamodb'
import * as StepFunctions from '@aws-cdk/aws-stepfunctions';
import * as StepFunctionTasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as Lambda from '@aws-cdk/aws-lambda';
import * as S3 from '@aws-cdk/aws-s3';
import { LayeredLambdas } from '@bifravst/package-layered-lambdas'
import { logToCloudWatch } from './logToCloudWatch'
import { lambdaLogGroup as lambdaLogGroup } from './lambdaLogGroup'
import { BifravstLambdas } from '../prepare-resources'

/**
 * Provides the resources for geolocating LTE/NB-IoT network cells
 */
export class CellGeolocation extends CloudFormation.Resource {
	public constructor(
		parent: CloudFormation.Stack,
		id: string,
		{
			sourceCodeBucket,
			baseLayer,
			lambdas,
		}: {
			sourceCodeBucket: S3.IBucket
			baseLayer: Lambda.ILayerVersion
			lambdas: LayeredLambdas<BifravstLambdas>
		},
	) {
		super(parent, id)

		const cacheTable = new DynamoDB.Table(this, 'cache', {
			billingMode: DynamoDB.BillingMode.PAY_PER_REQUEST,
			partitionKey: {
				name: 'cellId',
				type: DynamoDB.AttributeType.STRING,
			},
			pointInTimeRecovery: true,
			removalPolicy: CloudFormation.RemovalPolicy.RETAIN,
		})

		const deviceCellGeoLocations = new DynamoDB.Table(this, 'deviceCellGeoLocations', {
			billingMode: DynamoDB.BillingMode.PAY_PER_REQUEST,
			partitionKey: {
				name: 'uuid',
				type: DynamoDB.AttributeType.STRING,
			},
			sortKey: {
				name: 'timestamp',
				type: DynamoDB.AttributeType.NUMBER
			},
			pointInTimeRecovery: true,
			removalPolicy: CloudFormation.RemovalPolicy.RETAIN,
		})

		const LOCATIONS_TABLE_CELLID_INDEX = 'cellIdIndex'

		deviceCellGeoLocations.addGlobalSecondaryIndex({
			indexName: LOCATIONS_TABLE_CELLID_INDEX,
			partitionKey: {
				name: 'cellId',
				type: DynamoDB.AttributeType.STRING,
			},
			sortKey: {
				name: 'timestamp',
				type: DynamoDB.AttributeType.NUMBER
			},
			projectionType: DynamoDB.ProjectionType.INCLUDE,
			nonKeyAttributes: [
				'lat',
				'lng'
			]
		})

		const geolocateCellFromCache = new Lambda.Function(
			this,
			'geolocateCellFromCache',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.seconds(10),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.geolocateCellFromCache,
				),
				description: 'Geolocate cells from cache',
				initialPolicy: [
					logToCloudWatch,
					new IAM.PolicyStatement({
						actions: [
							'dynamodb:GetItem',
						],
						resources: [
							cacheTable.tableArn
						]
					})
				],
				environment: {
					CACHE_TABLE: cacheTable.tableName,
				},
			},
		)

		lambdaLogGroup(this, 'geolocateCellFromCache', geolocateCellFromCache)

		const geolocateCellFromDevices = new Lambda.Function(
			this,
			'geolocateCellFromDevices',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.seconds(10),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.geolocateCellFromDeviceLocations,
				),
				description: 'Geolocate cells from device locations',
				initialPolicy: [
					logToCloudWatch,
					new IAM.PolicyStatement({
						actions: [
							'dynamodb:Query',
						],
						resources: [
							deviceCellGeoLocations.tableArn,
							`${deviceCellGeoLocations.tableArn}/*`,
						]
					})
				],
				environment: {
					LOCATIONS_TABLE: deviceCellGeoLocations.tableName,
					LOCATIONS_TABLE_CELLID_INDEX
				},
			},
		)

		lambdaLogGroup(this, 'geolocateCellFromDevices', geolocateCellFromDevices)

		const cacheCellGeolocation = new Lambda.Function(
			this,
			'cacheCellGeolocation',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.minutes(1),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.geolocateCellFromCache,
				),
				description: 'Caches cell geolocations',
				initialPolicy: [
					logToCloudWatch,
					new IAM.PolicyStatement({
						actions: [
							'dynamodb:PutItem',
						],
						resources: [
							cacheTable.tableArn
						]
					})
				],
				environment: {
					CACHE_TABLE: cacheTable.tableName,
				},
			},
		)

		lambdaLogGroup(this, 'cacheCellGeolocation', cacheCellGeolocation)

		const geolocateCellFromUnwiredLabs = new Lambda.Function(
			this,
			'geolocateCellFromUnwiredLabs',
			{
				layers: [baseLayer],
				handler: 'index.handler',
				runtime: Lambda.Runtime.NODEJS_10_X,
				timeout: CloudFormation.Duration.seconds(10),
				memorySize: 1792,
				code: Lambda.Code.bucket(
					sourceCodeBucket,
					lambdas.lambdaZipFileNames.geolocateCellFromUnwiredLabs,
				),
				description: 'Resolve cell geolocation using the UnwiredLabs API',
				initialPolicy: [
					logToCloudWatch,
				],
				environment: {
				},
			},
		)

		lambdaLogGroup(this, 'geolocateCellFromUnwiredLabs', geolocateCellFromUnwiredLabs)

		const isGeolocated = StepFunctions.Condition.booleanEquals('$.celgeo.located', true)

		// FIXME: add step to resolve from device locations
		const stateMachine = new StepFunctions.StateMachine(this, 'StateMachine', {
			definition: new StepFunctions.Task(this, 'Resolve from cache', {
				task: new StepFunctionTasks.InvokeFunction(geolocateCellFromCache),
				resultPath: '$.celgeo'
			})
				.next(
					new StepFunctions.Choice(this, 'Cache found?')
						.when(
							isGeolocated,
							new StepFunctions.Succeed(this, 'Done (using Cache)'),
						)
						.otherwise(
							new StepFunctions.Task(this, 'Geolocation using Device Locations', {
								task: new StepFunctionTasks.InvokeFunction(geolocateCellFromDevices),
								resultPath: '$.celgeo'
							})
								.next(
									new StepFunctions.Choice(this, 'Geolocated using Device Locations?')
										.when(
											isGeolocated,
											new StepFunctions.Task(this, 'Cache result from Device Locations', {
												task: new StepFunctionTasks.InvokeFunction(cacheCellGeolocation),
												inputPath: '$.celgeo',
												resultPath: '$.storedInCache'
											})
												.next(new StepFunctions.Succeed(this, 'Done (using Device Locations)'))

										)
										.otherwise(
											new StepFunctions.Task(this, 'Resolve using UnwiredLabs API', {
												task: new StepFunctionTasks.InvokeFunction(geolocateCellFromUnwiredLabs),
												resultPath: '$.celgeo'
											})
												.next(
													new StepFunctions.Choice(this, 'Resolved from UnwiredLabs API?')
														.when(
															isGeolocated,
															new StepFunctions.Task(this, 'Cache result from UnwiredLabs API', {
																task: new StepFunctionTasks.InvokeFunction(cacheCellGeolocation),
																inputPath: '$.celgeo',
																resultPath: '$.storedInCache'
															})
																.next(new StepFunctions.Succeed(this, 'Done (using UnwiredLabs API)'))
														)
												)
										)
								)
						)
				),
			timeout: CloudFormation.Duration.minutes(5)
		})

		const topicRuleRole = new IAM.Role(this, 'Role', {
			assumedBy: new IAM.ServicePrincipal('iot.amazonaws.com'),
			inlinePolicies: {
				iot: new IAM.PolicyDocument({
					statements: [
						new IAM.PolicyStatement({
							actions: ['iot:Publish'],
							resources: [
								`arn:aws:iot:${parent.region}:${parent.account}:topic/errors`,
								`arn:aws:iot:${parent.region}:${parent.account}:topic/celgeo`,
							],
						}),
					],
				}),
				stepFunctions: new IAM.PolicyDocument({
					statements: [
						new IAM.PolicyStatement({
							actions: ['states:StartExecution'],
							resources: [
								stateMachine.stateMachineArn
							]
						})
					]
				}),
				dynamodb: new IAM.PolicyDocument({
					statements: [
						new IAM.PolicyStatement({
							actions: [
								'dynamodb:PutItem',
							],
							resources: [
								deviceCellGeoLocations.tableArn
							]
						})
					]
				})
			},
		})

		new IoT.CfnTopicRule(this, 'resolveCellIds', {
			topicRulePayload: {
				awsIotSqlVersion: '2016-03-23',
				description: 'Executes a step function which will geolocate the cell location provided by the device',
				ruleDisabled: false,
				sql: [
					'SELECT current.state.reported.roam.v AS roaming, clientid() as deviceId',
					`FROM '$aws/things/+/shadow/update/documents'`,
					'WHERE current.state.reported.roam.v.cell <> NULL',
					'AND current.state.reported.roam.v.mccmnc <> NULL',
					'AND current.state.reported.roam.v.area <> NULL',
					// Only trigger if the reported cell changed
					'AND previous.state.reported.roam.v.cell <> current.state.reported.roam.v.cell',
					// Only trigger if the current geolocation in the state is not for the new cell
					// it might not have been updated yet
					'AND current.state.desired.celgeo.v.cell <> current.state.reported.roam.v.cell'
				].join(' '),
				actions: [
					{
						stepFunctions: {
							stateMachineName: stateMachine.stateMachineName,
							roleArn: topicRuleRole.roleArn,
						}
					},
				],
				errorAction: {
					republish: {
						roleArn: topicRuleRole.roleArn,
						topic: 'errors',
					},
				},
			},
		})

		new IoT.CfnTopicRule(this, 'storeCellGeolocationsFromDevices', {
			topicRulePayload: {
				awsIotSqlVersion: '2016-03-23',
				description: 'Stores the geolocations for cells from devices',
				ruleDisabled: false,
				sql: [
					'SELECT',
					'newuuid() as uuid,',
					'current.state.reported.roam.v.cell as cell,',
					'current.state.reported.roam.v.mccmnc as mccmnc,',
					'current.state.reported.roam.v.area as area,',
					// see cellGeolocation/cellId.ts for format of cellId
					'concat(current.state.reported.roam.v.cell,',
					'"-",',
					'current.state.reported.roam.v.mccmnc,',
					'"-",',
					'current.state.reported.roam.v.area) AS cellId,',
					'current.state.reported.gps.v.lat AS lat,',
					'current.state.reported.gps.v.lng AS lng,',
					'concat("device:", clientid()) as source,',
					'timestamp() as timestamp',
					`FROM '$aws/things/+/shadow/update/documents'`,
					'WHERE',
					// only if it actually has roaming information
					'current.state.reported.roam.v.area <> NULL',
					'AND current.state.reported.roam.v.mccmnc <> NULL',
					'AND current.state.reported.roam.v.cell <> NULL',
					// only if the location has changed
					'AND (previous.state.reported.gps.v.lat <> current.state.reported.gps.v.lat',
					'OR previous.state.reported.gps.v.lng <> current.state.reported.gps.v.lng)'
				].join(' '),
				actions: [
					{
						republish: {
							roleArn: topicRuleRole.roleArn,
							topic: 'celgeo',
						}
					},
					{
						dynamoDBv2: {
							putItem: {
								tableName: deviceCellGeoLocations.tableName
							},
							roleArn: topicRuleRole.roleArn,
						}
					}
				],
				errorAction: {
					republish: {
						roleArn: topicRuleRole.roleArn,
						topic: 'errors',
					},
				},
			}
		})

		// FIXME: add rule to store geo locations with cells
	}
}
