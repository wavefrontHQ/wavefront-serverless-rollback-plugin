# wavefront-serverless-rollback-plugin
Serverless plugin for doing a Lambda rollback when wavefront alert triggered

### How it works
The plugin hooks into serverless' `deploy` command. When the `deploy` command is invoked, this what will happen:
* It downloads your service's previous CloudFormation template to be used as rollback target
* It uploads a rollback Lambda and sets up its REST API Gateway
* It creates a Wavefront webhook and alert to call the Lambda
* When the alert is triggered, it calls the Lambda and the Lambda executes the rollback using the previous version's CloudFormation template
* After rolling back, the Lambda deletes its REST API Gateway, the Wavefront alert, and itself

### New service setup
This is how to add the plugin to your service project.
#### From NPM
* Switch to your own serverless service project directory
* Run `npm install -g wavefront-serverless-rollback-plugin` to install plugin
* Add `wavefront-serverless-rollback-plugin` to plugin list in your `serverless.yml`
* Run `serverless deploy` to deploy your service with the rollback function
#### From Cloned Plugin Repo
Assuming you've cloned the plugin repo to `[path/to/plugin/dir]`.
* Switch to your own serverless service project directory
* Run `npm install -g [path/to/plugin/dir]` to install plugin
* Add `wavefront-serverless-rollback-plugin` to plugin list in your `serverless.yml`
* Run `serverless deploy` to deploy your service with the rollback function

### Serverless YAML options
See `serverless.yml` for custom option samples. Use custom options to modify the plugin's settings.
* `wavefrontDebugMode`: Optional, to use `/rollback` API path if in debug mode
* `wavefrontForceDeploy`: Optional, to force replace of existing rollback function
* `wavefrontApiKey`: Required, for calling the Wavefront API
* `wavefrontApiInstanceUrl`: Required, your wavefront instance URL for calling the Wavefront API
* `wavefrontRollbackAlertTriggerThreshold`: Optional, set how long the alert condition should be true before triggering an alert, min 2
* `wavefrontRollbackAlertCondition`: Required, set Wavefront alert condition with a `ts` query, example: watching for any Lambda error for the last 5 minutes: `'any(5m, ts(aws.lambda.errors, source="<function_name>"))'`, replace `<function_name>` with your service's function name
* `wavefrontAlertAdditionalTarget`: Optional, add list of email address or any custom Wavefront alert target here

### Customizing the rollback Lambda
Inside `[path/to/plugin/dir]/src-wavefront-serverless-rollback-plugin` directory you can find the default rollback Lambda, `rollback.js`. It will be called by the Wavefront alert.

To use additional npm packages in the rollback function, specify your dependencies both in `[path/to/plugin/dir]/package.json` and `[path/to/plugin/dir]/src-wavefront-serverless-rollback-plugin/rollbackPackage.json`, the plugin will automatically include them when deploying the function to Lambda.

If you modified the function in the cloned repo, you will need to run `npm install -g [path/to/plugin/dir]` again.

### Customizing the plugin
In the `[path/to/plugin/dir]` you can find `index.js` file where you can customize the plugin's main functions.

If you modified the plugin in the cloned repo, you will need to run `npm install -g [path/to/plugin/dir]` again.

### Building
* Switch to cloned directory
* Run `npm install` to install needed npm packages
* Run `serverless` to check if setup success
