import { BifravstApp } from './apps/Bifravst'
import { prepareResources } from './prepare-resources'

const STACK_ID = process.env.STACK_ID || 'bifravst'
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || ''

prepareResources({
	stackId: STACK_ID,
	region,
	rootDir: process.cwd(),
})
	.then(args => new BifravstApp(args).synth())
	.catch(err => {
		console.error(err)
		process.exit(1)
	})
