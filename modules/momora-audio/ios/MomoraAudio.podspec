require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MomoraAudio'
  s.version = package['version']
  s.summary = 'On-device audio decode, loudness analysis and trim/transcode for Momora sound memories.'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'Momora'
  s.homepage = 'https://github.com/eduardoyi/newmomora'
  s.source = { :git => 'https://github.com/eduardoyi/newmomora.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'AudioToolbox'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
