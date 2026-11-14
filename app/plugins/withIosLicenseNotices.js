const { withXcodeProject } = require('expo/config-plugins');

const name = 'Copy license notices';

module.exports = function withIosLicenseNotices(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const target = project.getFirstTarget();
    if (target.firstTarget.buildPhases.some((phase) => phase.comment === name)) return config;

    const resourceDir = '$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)';
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', name, target.uuid, {
      shellPath: '/bin/sh',
      shellScript: 'set -eu\ncp "$SCRIPT_INPUT_FILE_0" "$SCRIPT_OUTPUT_FILE_0"\ncp "$SCRIPT_INPUT_FILE_1" "$SCRIPT_OUTPUT_FILE_1"',
      inputPaths: ['"$(SRCROOT)/../../LICENSE"', '"$(SRCROOT)/../THIRD-PARTY-NOTICES.txt"'],
      outputPaths: [`"${resourceDir}/LICENSE"`, `"${resourceDir}/THIRD-PARTY-NOTICES.txt"`],
    });
    return config;
  });
};
