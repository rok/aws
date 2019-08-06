import { ComandDefinition } from './CommandDefinition'
import { athenaQuery } from '../../historicalData/athenaQuery'
import { Athena } from 'aws-sdk'
import {
	DataBaseName,
	TableName,
	WorkGroupName,
} from '../../historicalData/settings'
import chalk from 'chalk'
import { createAthenaTableSQL } from '../../historicalData/createAthenaTableSQL'
import { deviceMessagesFields } from '../../historicalData/deviceMessages'

export const historicalDataCommand = ({
	region,
	QueryResultsBucketName,
	DataBucketName,
}: {
	region: string
	QueryResultsBucketName: string
	DataBucketName: string
}): ComandDefinition => ({
	command: 'historical-data',
	options: [
		{
			flags: '-s, --setup',
			description: 'Set up the neccessary resources',
		},
		{
			flags: '-r, --recreate',
			description: 'Recreates the historical data table',
		},
		{
			flags: '-d, --debug',
			description: 'Debug Athena queries',
		},
	],
	action: async ({
		setup,
		debug,
		recreate,
	}: {
		setup: boolean
		debug: boolean
		recreate: boolean
	}) => {
		const athena = new Athena({ region })

		const { WorkGroups } = await athena.listWorkGroups().promise()

		if (
			!WorkGroups ||
			!WorkGroups.find(
				({ Name, State }) => State === 'ENABLED' && Name === WorkGroupName,
			)
		) {
			if (setup) {
				console.log(chalk.magenta(`Creating workgroup...`))
				await athena
					.createWorkGroup({
						Name: WorkGroupName,
						Description: 'Workgroup for Bifravst',
						Configuration: {
							ResultConfiguration: {
								OutputLocation: `s3://${QueryResultsBucketName}/`,
							},
						},
					})
					.promise()
			} else {
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(
						`Athena workgroup ${chalk.blue(WorkGroupName)} does not exist!`,
					),
				)
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(`Pass --setup to create it.`),
				)
				return
			}
		}
		console.log(
			chalk.green.inverse(' OK '),
			chalk.gray(`Athena workgroup ${chalk.blue(WorkGroupName)} exists.`),
		)

		const query = athenaQuery({
			athena,
			WorkGroup: WorkGroupName,
			logDebug: message => {
				if (debug) {
					console.debug(chalk.gray('[Athena]'), chalk.blue(message))
				}
			},
		})
		const dbs = await query({
			QueryString: `SHOW DATABASES`,
		})
		if (!dbs.find(({ database_name: db }) => db === DataBaseName)) {
			if (setup) {
				console.log(chalk.magenta(`Creating database...`))
				await query({
					QueryString: `CREATE DATABASE ${DataBaseName}`,
				})
			} else {
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(
						`Athena database ${chalk.blue(DataBaseName)} does not exist!`,
					),
				)
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(`Pass --setup to create it.`),
				)
				return
			}
		}
		console.log(
			chalk.green.inverse(' OK '),
			chalk.gray(`Athena database ${chalk.blue(DataBaseName)} exists.`),
		)

		if (recreate) {
			console.log(chalk.magenta(`Dropping table...`))
			await query({ QueryString: `DROP TABLE ${DataBaseName}.${TableName}` })
		}

		try {
			await query({
				QueryString: `DESCRIBE ${DataBaseName}.${TableName}`,
			})
		} catch (error) {
			if (setup) {
				console.log(chalk.magenta(`Creating table...`))
				await query({
					QueryString: createAthenaTableSQL({
						database: DataBaseName,
						table: TableName,
						s3Location: `s3://${DataBucketName}/`,
						fields: deviceMessagesFields,
					}),
				})
			} else {
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(
						`Athena table ${chalk.blue(
							`${DataBaseName}.${TableName}`,
						)} does not exist!`,
					),
				)
				console.log(
					chalk.red.inverse(' ERROR '),
					chalk.red(`Pass --setup to create it.`),
				)
				return
			}
		}

		console.log(
			chalk.green.inverse(' OK '),
			chalk.gray(
				`Athena table ${chalk.blue(`${DataBaseName}.${TableName}`)} exists.`,
			),
		)
	},
	help: 'Manages the AWS Athena resources for historical data',
})