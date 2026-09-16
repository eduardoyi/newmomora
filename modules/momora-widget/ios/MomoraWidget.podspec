require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MomoraWidget'
  s.version = package['version']
  s.summary = 'Private local storage for the Momora home-screen widget.'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'Momora'
  s.homepage = 'https://github.com/eduardoyi/newmomora'
  s.source = { :git => 'https://github.com/eduardoyi/newmomora.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit', 'ImageIO'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
