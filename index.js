//
// Copyright (c) 2017 Wavefront. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const BbPromise = require('bluebird');
const util = require('util');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const glob = require('glob-all');
const findParentDir = require('find-parent-dir');
const jsonfile = require('jsonfile');
const _ = require('lodash');
const uuidV4 = require('uuid/v4');
const copydir = require('copy-dir');
const rimraf = require('rimraf');
var wildstring = require('wildstring');
const request = BbPromise.promisify(require("request"), {multiArgs: true});
BbPromise.promisifyAll(request, {multiArgs: true})


class ServerlessWavefrontRollback {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');

    this.hooks = {
      'before:deploy:deploy': () => BbPromise.bind(this)
        .then(this.init)
        .then(this.checkMandatoryParams)
        .then(this.getPreviousTemplate),

      'after:deploy:deploy': () => BbPromise.bind(this)
        // .then(this.debugParams)
        .then(this.checkDeployment)
        .then(this.getResources)
        .then(this.createApiGateway)
        .then(this.getApiGatewayParams)
        .then(this.setInitialApiGatewayParams)
        .then(this.setIamRole)
        .then(this.deployRollbackFunction)
        .then(this.setRollbackFunctionApiGatewayParams)
        .then(this.deployWavefrontAlert),

      'before:remove:remove': () => BbPromise.bind(this)
        .then(this.init)
        .then(this.getResources)
        .then(this.removeApiGateway)
        .then(this.removeRollbackFunction)
        .then(this.removeIAMRole)
        .then(this.removeWavefrontAlert)
    };

    // this.serverless.cli.log(util.inspect(this.options, false, null));
  }

  debugParams() {
    this.serverless.cli.log(util.inspect(Object.keys(this.serverless.service.functions), false, null));
  }

  init() {
    this.options.stage = this.options.stage
      || (this.serverless.service.provider && this.serverless.service.provider.stage)
      || 'dev';
    this.options.region = this.options.region
      || (this.serverless.service.provider && this.serverless.service.provider.region)
      || 'us-east-1';

    this.previousTemplate;
    this.cloudFormationResources = [];
    this.apiGatewayResources = [];
    this.artifactFilePath = '';
    this.deployedFunctionParams = {};
    this.restApiCFParams = {};
    this.restApiId = {};
    this.apiGatewayResource = {};
    this.iamRole = {};

    this.maxRetries = 5;
    this.pluginName = 'wavefront-serverless-rollback-plugin';
    this.pluginShortName = 'wf-rollback';
    this.functionName = [this.pluginShortName, this.serverless.service.service, this.options.stage].join('-');
    this.roleName = [this.pluginShortName, this.serverless.service.service, this.options.stage, 'role'].join('-');
    this.policyName = [this.pluginShortName, this.serverless.service.service, this.options.stage, 'policy'].join('-');
    this.srcDir = ['src', this.pluginName].join('-');
    this.tempDir = ['.', this.pluginName].join('');
    this.paramsFile = 'params.json';
    this.localParamsFile = 'localParams.json';
    this.restApiPath = 'rollback';
    this.wildcardFunctionName = '<function_name>';
    this.restApiOwnName = [this.options.stage, this.serverless.service.service, this.pluginShortName].join('-');;
    
    this.wavefrontApiKey = this.serverless.service.custom.wavefrontApiKey;
    this.srcParentDir;

    try {
      this.srcParentDir = findParentDir.sync(__dirname, this.srcDir);
    }
    catch(err) {
      throw new this.serverless.classes
        .Error('Plugin src folder not found. Make sure the plugin is installed.');
    }

    if (!this.serverless.service.custom.wavefrontDebugMode) {
      this.restApiPath = uuidV4();
    }

    const servicePath = this.serverless.config.servicePath;
    const zipFileName = 'wavefront-serverless-rollback-plugin.zip';

    this.artifactFilePath = path.join(
      servicePath,
      this.tempDir,
      zipFileName
    );

    this.localParamsFilePath = path.resolve(
      servicePath,
      this.tempDir,
      this.localParamsFile
    );

    const dir = path.resolve(
      servicePath,
      this.tempDir
    );
    if (!fs.existsSync(dir)){
      fs.mkdirSync(dir);
    }

    try {
      this.prevLocalParams = jsonfile.readFileSync(this.localParamsFilePath);
    }
    catch(err) { }

    jsonfile.writeFileSync(this.localParamsFilePath, { APIGatewayResource: { path: this.restApiPath } });
  }

  checkMandatoryParams() {

    if (!this.wavefrontApiKey) {
      throw new this.serverless.classes
        .Error('Please provide Wavefront API Key using custom wavefrontApiKey option.');
    }

    if (!this.serverless.service.custom.wavefrontApiInstanceUrl) {
      throw new this.serverless.classes
        .Error('Please provide Wavefront instance URL using custom wavefrontApiInstanceUrl option.');
    }

    if (!/^(f|ht)tps?:\/\//i.test(this.serverless.service.custom.wavefrontApiInstanceUrl)) {
      throw new this.serverless.classes
        .Error('Please provide complete Wavefront instance URL in wavefrontApiInstanceUrl option.');
    }

    if (!this.serverless.service.custom.wavefrontRollbackAlertCondition) {
      throw new this.serverless.classes
        .Error('Please provide Wavefront alert trigger condition using custom wavefrontRollbackAlertCondition option.');
    }
  }

  getPreviousTemplate() {
    this.serverless.cli.log('Getting previous CloudFormation template...');

    const stackName = this.provider.naming.getStackName(this.options.stage);

    return this.provider.request('CloudFormation',
      'getTemplate',
      { StackName: stackName },
      this.options.stage,
      this.options.region)
    .catch((err) => {
      this.serverless.cli.log('First deployment detected');
    })
    .then((result) => {
      if (result) {
        this.previousTemplate = result.TemplateBody;
        this.serverless.cli.log('Template acquired');
        // this.serverless.cli.log(util.inspect(this.previousTemplate, false, null));
      }

      return BbPromise.resolve();
    });
  }

  checkDeployment() {
    if (!this.previousTemplate){
      return BbPromise.reject('First deployment detected, will not upload rollback function.');
    }
    else {
      return BbPromise.resolve();
    }
  }

  getResources() {
    this.serverless.cli.log('Getting CloudFormation resource...');

    const stackName = this.provider.naming.getStackName(this.options.stage);

    var params = {
      StackName: stackName
    };

    return this.provider.request('CloudFormation',
      'describeStackResources',
      params,
      this.options.stage,
      this.options.region)
    .then((result) => {
      if (result) {
        this.serverless.cli.log('CloudFormation resources acquired');
        this.cloudFormationResources = result.StackResources;
        // this.serverless.cli.log(util.inspect(result, false, null));

        this.restApiCFParams = _.find(this.cloudFormationResources, function(res) {
          wildstring.wildcard = '*';
          return wildstring.match('ApiGatewayRestApi*', res.LogicalResourceId);
        });
      }
      else
        this.serverless.cli.log('Failed getting resource');

      return BbPromise.resolve(result);
    });
  }

  createApiGateway() {
    if (!this.restApiCFParams || !this.restApiCFParams.PhysicalResourceId) {
      this.serverless.cli.log('No API Gateway resource from user...');
      return this.provider.request(
        'APIGateway',
        'getRestApis',
        { },
        this.options.stage,
        this.options.region)
      .then((result) => {
        let restApi = _.find(result.items, {name: this.restApiOwnName});
        if (restApi) {
          this.serverless.cli.log('Reusing plugin owned API Gateway');
          this.restApiId = restApi.id;
          return true;
        }
        return false;
      })
      .then((result) => {
        if (!result) {
          // Need to create own API
          this.serverless.cli.log('Creating API Gateway param...');
          return this.provider.request(
            'APIGateway',
            'createRestApi',
            { name: this.restApiOwnName },
            this.options.stage,
            this.options.region)
          .catch((err) => {
            BbPromise.reject(err);
          })
          .then((result) => {
            this.restApiId = result.id;
            return BbPromise.resolve();
          })
        }
        return BbPromise.resolve();
      });
    }

    this.restApiId = this.restApiCFParams.PhysicalResourceId;
    // Deleting plugin's API gateway if any
    return this.provider.request(
      'APIGateway',
      'getRestApis',
      { },
      this.options.stage,
      this.options.region)
    .then((result) => {
      let restApi = _.find(result.items, {name: this.restApiOwnName});
      if (restApi) {
        this.serverless.cli.log('Deleting unused plugin owned API Gateway...');
        return this.provider.request(
          'APIGateway',
          'deleteRestApi',
          { restApiId: restApi.id },
          this.options.stage,
          this.options.region);
      }
      return BbPromise.resolve();
    })
  }

  getApiGatewayParams() {
    this.serverless.cli.log('Getting API Gateway param...');

    return this.provider.request('APIGateway',
      'getResources',
      { restApiId: this.restApiId },
      this.options.stage,
      this.options.region)
    .then((result) => {
      if (result) {
        this.serverless.cli.log('API Gateway resources acquired');
        this.apiGatewayResources = result.items;
        // this.serverless.cli.log(util.inspect(result, false, null));
      }
      else
        this.serverless.cli.log('Failed getting resource');

      return BbPromise.resolve(result);
    });
  }

  setInitialApiGatewayParams() {
    this.serverless.cli.log('Setup API Gateway...');

    const apiGatewayResourceRoot = _.find(this.apiGatewayResources, {path: '/'});
    const previousApiGatewayResource = this.prevLocalParams
      ? _.find(this.apiGatewayResources, {pathPart: this.prevLocalParams.APIGatewayResource.path})
      : undefined;

    if (previousApiGatewayResource) {
      this.serverless.cli.log('API Gateway resource already exists');

      if (!this.serverless.service.custom.wavefrontForceDeploy) {
        return BbPromise.reject('A rollback function API gateway already exists. Use wavefrontForceDeploy custom option to force update the rollback function.');
      }

      this.serverless.cli.log('Deleting existing API Gateway resource...');
    }

    return this.provider.request(
      'APIGateway',
      'deleteResource',
      {
        restApiId: this.restApiId,
        resourceId: previousApiGatewayResource ? previousApiGatewayResource.id : null
      },
      this.options.stage,
      this.options.region
    )
    .catch(() => {})
    .then(() => {
      this.serverless.cli.log('Creating API Gateway resource...');
      return this.provider.request(
        'APIGateway',
        'createResource',
        {
          restApiId: this.restApiId,
          parentId: apiGatewayResourceRoot.id,
          pathPart: this.restApiPath
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.apiGatewayResource = result;
      return BbPromise.resolve();
    });
  }

  setRollbackFunctionApiGatewayParams() {
      
    var functionArn;
    if (this.deployedFunctionParams.Version == '$LATEST') {
      functionArn = this.deployedFunctionParams.FunctionArn;
    }
    else {
      let indexToRemove = this.deployedFunctionParams.FunctionArn.lastIndexOf(':');
      functionArn = this.deployedFunctionParams.FunctionArn.substring(0, indexToRemove);
    }
    

    this.serverless.cli.log('Creating API Gateway GET method...');
    return this.provider.request(
      'APIGateway',
      'putMethod',
      {
        authorizationType: 'NONE',
        httpMethod: 'GET',
        resourceId: this.apiGatewayResource.id,
        restApiId: this.restApiId,
        apiKeyRequired: false
      },
      this.options.stage,
      this.options.region)
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.serverless.cli.log('Creating API Gateway GET integration request...');
      return this.provider.request(
        'APIGateway',
        'putIntegration',
        {
          httpMethod: 'GET',
          resourceId: this.apiGatewayResource.id,
          restApiId: this.restApiId,
          type: 'AWS_PROXY',
          integrationHttpMethod: 'POST',
          uri: 'arn:aws:apigateway:'
          + this.options.region
          + ':lambda:path/2015-03-31/functions/'
          + functionArn
          + '/invocations'
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.serverless.cli.log('Creating API Gateway POST method...');
      return this.provider.request(
        'APIGateway',
        'putMethod',
        {
          authorizationType: 'NONE',
          httpMethod: 'POST',
          resourceId: this.apiGatewayResource.id,
          restApiId: this.restApiId,
          apiKeyRequired: false
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.serverless.cli.log('Creating API Gateway POST integration request...');
      return this.provider.request(
        'APIGateway',
        'putIntegration',
        {
          httpMethod: 'POST',
          resourceId: this.apiGatewayResource.id,
          restApiId: this.restApiId,
          type: 'AWS_PROXY',
          integrationHttpMethod: 'POST',
          uri: 'arn:aws:apigateway:'
          + this.options.region
          + ':lambda:path/2015-03-31/functions/'
          + functionArn
          + '/invocations'
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.serverless.cli.log('Creating API Gateway deployment...');
      return this.provider.request(
        'APIGateway',
        'createDeployment',
        {
          restApiId: this.restApiId,
          stageName: this.options.stage,
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.serverless.cli.log('Removing Lambda permission...');
      return this.provider.request(
        'Lambda',
        'removePermission',
        {
          FunctionName: this.deployedFunctionParams.FunctionName,
          StatementId: this.functionName + '-statementID',
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
    })
    .then((result) => {
      this.serverless.cli.log('Adding Lambda permission...');
      return this.provider.request(
        'Lambda',
        'addPermission',
        {
          Action: 'lambda:InvokeFunction',
          FunctionName: this.deployedFunctionParams.FunctionName,
          Principal: 'apigateway.amazonaws.com',
          StatementId: this.functionName + '-statementID',
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    });
  }

  setIamRole() {
    return this.removeIAMRole()
    .then(() => {
      this.serverless.cli.log('Creating new IAM role...');
      return this.provider.request(
      'IAM',
      'createRole',
      {
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: 
            [{ 
              Effect: 'Allow',
              Principal: { Service: [ 'lambda.amazonaws.com' ] },
              Action: [ 'sts:AssumeRole' ]
            }]
        }),
        Path: "/",
        RoleName: this.roleName
      },
      this.options.stage,
      this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    })
    .then((result) => {
      this.iamRole = result.Role;
      this.serverless.cli.log('Creating IAM role policy...');
      return this.provider.request(
      'IAM',
      'putRolePolicy',
      {
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: 
            [
              {
                Effect: 'Allow',
                Action: [ 
                  'cloudformation:Describe*',
                  'cloudformation:Get*',
                  'cloudformation:Create*',
                  'cloudformation:Update*',
                  'apigateway:Get*',
                  'apigateway:POST',
                  'apigateway:DELETE',
                  'logs:Describe*',
                  'logs:Create*',
                  'logs:Delete*',
                  'iam:Put*',
                  'iam:Get*',
                  'events:*',
                  'lambda:*',
                  's3:Get*' ],
                Resource: '*'
              }
            ] 
        }),
        PolicyName: this.policyName,
        RoleName: this.roleName
      },
      this.options.stage,
      this.options.region);
    })
    .catch((err) => {
      BbPromise.reject(err);
    });
  }

  deployRollbackFunction() {

    this.serverless.cli.log(`Checking for rollback function ${this.functionName}...`);
    
    return this.provider.request(
      'Lambda',
      'getFunction',
      { FunctionName: this.functionName },
      this.options.stage, this.options.region
    )
    .catch(() => {
      this.serverless.cli.log('Rollback function does not exist yet');
      return false;
    })
    .then((isExist) => {

      if (isExist && !this.serverless.service.custom.wavefrontForceDeploy) {
        return BbPromise.reject('A rollback Lambda function already exists. Use wavefrontForceDeploy custom option to force update the rollback function.');
      }

      this.generateJsonParams();
      
      return this.zipDirectory()
      .then((result) => {

        var that = this;

        // Create new Lambda function
        if (!isExist) {
          this.serverless.cli.log('Creating new rollback function...');
          this.serverless.cli.log('Deploying rollback lambda function...');

          return this.retry(this.maxRetries, function(){
            const data = fs.readFileSync(that.artifactFilePath);

            const createParams = {
              FunctionName: that.functionName,
              Handler: 'src-wavefront-serverless-rollback-plugin/rollback.rollback',
              Role: that.iamRole.Arn,
              Runtime: 'nodejs4.3',
              Code: {
                ZipFile: data
              }
            };

            return that.provider.request(
              'Lambda',
              'createFunction',
              createParams,
              that.options.stage, that.options.region
            );

          })
          .then((res) => {
            this.deployedFunctionParams = res;
            this.serverless.cli.log(`Successfully deployed rollback function ${this.functionName}`);
          });
        }
        // Update existing Lambda function
        else {
          this.serverless.cli.log('Rollback function already exists');
          this.serverless.cli.log('Updating rollback function...');
          this.serverless.cli.log('Deploying rollback lambda function...');

          return this.retry(this.maxRetries, function(){

            const data = fs.readFileSync(that.artifactFilePath);

            const createParams = {
              FunctionName: that.functionName,
              Publish: true,
              ZipFile: data
            };

            return that.provider.request(
              'Lambda',
              'updateFunctionCode',
              createParams,
              that.options.stage, that.options.region
            )
          })
          .then((res) => {
            this.deployedFunctionParams = res;
            this.serverless.cli.log(`Successfully deployed rollback function ${this.functionName}`);
          });
        }
      });
    });

    return BbPromise.resolve();
  }

  deployWavefrontAlert() {
    this.serverless.cli.log('Deploying Wavefront rollback trigger...');

    const wavefrontHost = this.serverless.service.custom.wavefrontApiInstanceUrl;
    const rollbackFunctionPath = 'https://'
      + this.restApiId
      + '.execute-api.'
      + this.options.region
      + '.amazonaws.com/'
      + this.options.stage
      + '/';
    const rollbackFunctionEndpoint = rollbackFunctionPath + this.restApiPath;
    const userFunctionResources = _.filter(this.cloudFormationResources, {ResourceType: 'AWS::Lambda::Function'});
    const alertCondition = this.serverless.service.custom.wavefrontRollbackAlertCondition;
    const alertMinutes =
      this.serverless.service.custom.wavefrontRollbackAlertTriggerThreshold
        ? this.serverless.service.custom.wavefrontRollbackAlertTriggerThreshold
        : 2;

    var currentWebhook = {};

    this.serverless.cli.log('Getting existing Wavefront webhooks...');

    return request({
      url: wavefrontHost + '/api/v2/webhook',
      headers: {
        'Authorization': 'Bearer ' + this.wavefrontApiKey
      }
    })
    .spread((response, body, error) => {
      const bodyJson = JSON.parse(body);

      if (error) {
        return BbPromise.reject(error);
      }

      wildstring.wildcard = '*';
      const previousWebhook = _.find(bodyJson.response.items, function(item) {
        return wildstring.match(rollbackFunctionPath + '*', item.recipient);
      });
      const webhookParams = {
        description: 'Call rollback lambda for ' + this.provider.naming.getStackName(this.options.stage),
        template: '{"alertId": "{{{alertId}}}", "notificationId": "{{{notificationId}}}", "reason": "{{{reason}}}", "name": "{{#jsonEscape}}{{{name}}}{{/jsonEscape}}", "severity": "{{{severity}}}", "condition": "{{#jsonEscape}}{{{condition}}}{{/jsonEscape}}", "url": "{{{url}}}", "createdTime": "{{{createdTime}}}", "startedTime": "{{{startedTime}}}", "sinceTime": "{{{sinceTime}}}", "endedTime": "{{{endedTime}}}", "subject": "{{#jsonEscape}}{{{subject}}}{{/jsonEscape}}", "hostsFailingMessage": "{{#jsonEscape}}{{{hostsFailingMessage}}}{{/jsonEscape}}", "errorMessage": "{{#jsonEscape}}{{{errorMessage}}}{{/jsonEscape}}", "additionalInformation": "{{#jsonEscape}}{{{additionalInformation}}}{{/jsonEscape}}"}',
        title: 'Trigger Rollback Lambda',
        triggers: [
          'ALERT_OPENED'
        ],
        recipient: rollbackFunctionEndpoint,
        customHttpHeaders: {},
        contentType: 'application/json'
      };

      if (previousWebhook) {
        this.serverless.cli.log('Reusing existing Wavefront webhook...');
        return request(
          {
            url: wavefrontHost + '/api/v2/webhook/' + previousWebhook.id,
            method: 'PUT',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            },
            json: webhookParams
          })
        .spread((response, body, error) => {
          if (error) {
            return BbPromise.reject(error);
          }
          return BbPromise.resolve(body.response);
        });
      }
      else {
        this.serverless.cli.log('Creating new Wavefront webhook...');
        return request(
          {
            url: wavefrontHost + '/api/v2/webhook',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            },
            json: webhookParams
          })
        .spread((response, body, error) => {
          if (error) {
            return BbPromise.reject(error);
          }
          return BbPromise.resolve(body.response);
        });
      }
    })
    .then((webhook) => {
      // this.serverless.cli.log(util.inspect(webhook, false, null));
      currentWebhook = webhook;

      this.serverless.cli.log('Getting existing Wavefront alerts...');

      return request({
        url: wavefrontHost + '/api/v2/alert',
        headers: {
          'Authorization': 'Bearer ' + this.wavefrontApiKey
        }
      });
    })
    .spread((response, body, error) => {
      const bodyJson = JSON.parse(body);
      // this.serverless.cli.log(util.inspect(bodyJson, false, null));

      if (error) {
        return BbPromise.reject(error);
      }

      var alertTarget = 'webhook:' + currentWebhook.id;

      if (this.serverless.service.custom.wavefrontAlertAdditionalTarget
        && this.serverless.service.custom.wavefrontAlertAdditionalTarget.length > 0) {
        alertTarget = [alertTarget]
          .concat(this.serverless.service.custom.alertAdditionalTarget)
          .join(', ');
      }

      BbPromise.map(userFunctionResources, (res) => {
        let functionName = res.PhysicalResourceId;
        let alertName = 'Alert for ' + functionName;

        const previousAlert = _.find(bodyJson.response.items, function(alert){
          return alert.name == alertName;
        });

        wildstring.wildcard = this.wildcardFunctionName;
        let condition = wildstring.replace(alertCondition, functionName);
        const alertParams = {
          name: alertName,
          target: alertTarget,
          condition: condition,
          minutes: alertMinutes,
          severity: 'INFO'
        };

        if (previousAlert) {
          this.serverless.cli.log('Reusing existing Wavefront alert...');
          alertParams.id = previousAlert.id;
          return request({
            url: wavefrontHost + '/api/v2/alert/' + previousAlert.id,
            method: 'PUT',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            },
            json: alertParams
          });
        }
        else {
          this.serverless.cli.log('Creating new Wavefront alert...');
          return request({
            url: wavefrontHost + '/api/v2/alert',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            },
            json: alertParams
          });
        }
      })
      .catch((err) => {
        return BbPromise.reject(err);
      });
    });
  }

  removeApiGateway() {
    if (!this.restApiCFParams || !this.restApiCFParams.PhysicalResourceId) {
      this.serverless.cli.log('API Gateway does not exists');
      return BbPromise.resolve();
    }

    this.restApiId = this.restApiCFParams.PhysicalResourceId;

    return this.getApiGatewayParams()
    .then(() => {
      const previousApiGatewayResource = this.prevLocalParams
        ? _.find(this.apiGatewayResources, {pathPart: this.prevLocalParams.APIGatewayResource.path})
        : undefined;
      
      this.serverless.cli.log('Removing API Gateway...');
      return this.provider.request(
        'APIGateway',
        'deleteResource',
        {
          restApiId: this.restApiId,
          resourceId: previousApiGatewayResource ? previousApiGatewayResource.id : null
        },
        this.options.stage,
        this.options.region);
    })
    .catch((err)=>{
      // this.serverless.cli.log(util.inspect(err, false, null));
    })
    .then((result) => {
      return BbPromise.resolve();
    });
  }

  removeIAMRole() {
    this.serverless.cli.log('Removing IAM Role...');
    return this.provider.request(
      'IAM',
      'deleteRolePolicy',
      {
        RoleName: this.roleName,
        PolicyName: this.policyName
      },
      this.options.stage,
      this.options.region)
    .catch((err) => {
      // this.serverless.cli.log(util.inspect(err, false, null));
    })
    .then(() => {
      return this.provider.request(
      'IAM',
      'deleteRole',
      {
        RoleName: this.roleName
      },
      this.options.stage,
      this.options.region);
    })
    .catch((err) => {
      // this.serverless.cli.log(util.inspect(err, false, null));
    })
    .then(() => {
      return BbPromise.resolve();
    });
  }

  removeRollbackFunction() {
    this.serverless.cli.log('Removing rollback function...');
    return this.provider.request(
      'Lambda',
      'deleteFunction',
      {
        FunctionName: this.functionName
      },
      this.options.stage,
      this.options.region)
    .catch((err) => {
      // this.serverless.cli.log(util.inspect(err, false, null));
    })
    .then(() => {
      return BbPromise.resolve();
    });
  }

  removeWavefrontAlert() {
    const wavefrontHost = this.serverless.service.custom.wavefrontApiInstanceUrl;
    const rollbackFunctionPath = 'https://'
      + this.restApiId
      + '.execute-api.'
      + this.options.region
      + '.amazonaws.com/'
      + this.options.stage
      + '/';
    const userFunctionResources = _.filter(this.cloudFormationResources, {ResourceType: 'AWS::Lambda::Function'});

    this.serverless.cli.log('Removing Wavefront alert...');
    return request({
      url: wavefrontHost + '/api/v2/webhook',
      headers: {
        'Authorization': 'Bearer ' + this.wavefrontApiKey
      }
    })
    .spread((response, body, error) => {
      const bodyJson = JSON.parse(body);

      if (error) {
        return BbPromise.resolve();
      }

      wildstring.wildcard = '*';
      const previousWebhook = _.find(bodyJson.response.items, function(item) {
        return wildstring.match(rollbackFunctionPath + '*', item.recipient);
      });

      if (previousWebhook) {
        return request(
          {
            url: wavefrontHost + '/api/v2/webhook/' + previousWebhook.id,
            method: 'DELETE',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            }
          })
        .spread((response, body, error) => {
          return BbPromise.resolve();
        });
      }
    })
    .then(() => {
      // this.serverless.cli.log(util.inspect(webhook, false, null));
      return request({
        url: wavefrontHost + '/api/v2/alert',
        headers: {
          'Authorization': 'Bearer ' + this.wavefrontApiKey
        }
      });
    })
    .spread((response, body, error) => {
      const bodyJson = JSON.parse(body);
      // this.serverless.cli.log(util.inspect(bodyJson, false, null));

      if (error) {
        return BbPromise.resolve();
      }

      BbPromise.map(userFunctionResources, (res) => {
        let functionName = res.PhysicalResourceId;
        let alertName = 'Alert for ' + functionName;

        const previousAlert = _.find(bodyJson.response.items, function(alert){
          return alert.name == alertName;
        });

        if (previousAlert) {
          return request({
            url: wavefrontHost + '/api/v2/alert/' + previousAlert.id,
            method: 'DELETE',
            headers: {
              'Authorization': 'Bearer ' + this.wavefrontApiKey
            }
          });
        }
      })
      .catch((err) => {});
    })
    .then(() => {
      return BbPromise.resolve();
    });
  }

  generateJsonParams() {
    this.serverless.cli.log('Generating function params...');
    
    const fullPath = path.resolve(
          this.srcParentDir,
          this.srcDir,
          this.paramsFile
        );

    const wavefrontHost = this.serverless.service.custom.wavefrontApiInstanceUrl.replace(/^https?\:\/\//i, "");

    const jsonObj = {
      CloudFormationRollbackParam: {
        StackName: this.provider.naming.getStackName(this.options.stage),
        TemplateBody: this.previousTemplate,
        Capabilities: ['CAPABILITY_NAMED_IAM']
      },
      WavefrontApiParam: {
        Authorization: 'Bearer ' + this.wavefrontApiKey,
        WavefrontHost: wavefrontHost
      },
      LambdaFunctionParam: {
        FunctionName: this.functionName
      },
      ApiGatewayParam: {
        resourceId: this.apiGatewayResource.id,
        restApiId: this.restApiId
      },
      RolePolicyParam: {
        RoleName: this.roleName,
        PolicyName: this.policyName
      }
    };

    jsonfile.writeFileSync(fullPath, jsonObj);

    return BbPromise.resolve();
  }

  zipDirectory() {

    this.serverless.cli.log('Zipping rollback function files...');

    const patterns = [
      '**/' + this.srcDir + '/**',
      '!**/' + this.tempDir + '/**',
      ];


    /*
    *   Function taken from serverless/lib/plugins/package with modification
    *   Might want to implement custom include/exclude pattern
    *   in case user want to customize the plugin with their own code
    *


    exclude.forEach((pattern) => {
      if (pattern.charAt(0) !== '!') {
        patterns.push(`!${pattern}`);
      } else {
        patterns.push(pattern.substring(1));
      }
    });

    push the include globs to the end of the array
    (files and folders will be re-added again even if they were excluded beforehand)
    include.forEach((pattern) => {
      patterns.push(pattern);
    });

    */



    const localModulesDir = path.resolve(
      this.srcParentDir,
      this.srcDir,
      'node_modules'
    );
    const localModulesPath = path.resolve(
      this.srcParentDir,
      this.srcDir,
      'rollbackPackage.json'
    );
    const modulesDir = path.resolve(
      this.srcParentDir,
      'node_modules'
    );

    if (fs.existsSync(localModulesDir))
      rimraf.sync(localModulesDir);
    fs.mkdirSync(localModulesDir);

    let localModules;
    try {
      localModules = jsonfile.readFileSync(localModulesPath);
      this.serverless.cli.log(util.inspect(localModules, false, null));
      if (localModules) {
        this.copyModules(Object.keys(localModules.dependencies), modulesDir, localModulesDir);
      }
    }
    catch(err) {
      this.serverless.cli.log(util.inspect(err, false, null));
    }

    const zip = archiver.create('zip');
    const output = fs.createWriteStream(this.artifactFilePath);

    output.on('open', () => {
      zip.pipe(output);

      const files = glob.sync(patterns, {
        cwd: this.srcParentDir,
        dot: true,
        silent: true,
        follow: true,
      });

      // this.serverless.cli.log(util.inspect(files, false, null));

      files.forEach((filePath) => {
        const fullPath = path.resolve(
          this.srcParentDir,
          filePath
        );

        const stats = fs.statSync(fullPath);

        // this.serverless.cli.log(util.inspect(fullPath, false, null));

        if (!stats.isDirectory(fullPath)) {
          zip.append(fs.readFileSync(fullPath), {
            name: filePath,
            mode: stats.mode,
          });
        }
      });

      zip.finalize();
    });

    return new BbPromise((resolve, reject) => {
      output.on('close', () => resolve(this.artifactFilePath));
      zip.on('error', (err) => reject(err));
    });
  }

  copyModules(depArr, from, to) {
    var that = this;
    _.each(depArr, function(dep){
      let modulePathFrom = path.resolve(from, dep);
      let modulePathTo = path.resolve(to, dep);
      if (fs.existsSync(modulePathFrom)){

        fs.mkdirSync(modulePathTo);
        that.serverless.cli.log(`Copying ${modulePathFrom}`);
        copydir.sync(modulePathFrom, modulePathTo);

        let packageFile = path.resolve(modulePathFrom, 'package.json');
        try {
          let pack = jsonfile.readFileSync(packageFile);
          if (pack && pack.dependencies) {
            that.copyModules(Object.keys(pack.dependencies), from , to);
          }
        } catch(err){}
      }
    });
  }

  retry(maxRetries, fn) {
    var that = this;
    return fn().catch(function(err) { 
      if (maxRetries <= 0) {
        throw err;
      }
      return BbPromise.delay(1000).then(() => {
        return that.retry(maxRetries - 1, fn);
      });
    });
  }
}

module.exports = ServerlessWavefrontRollback;
