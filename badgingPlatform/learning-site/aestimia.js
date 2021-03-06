const Api = require('./api');
const async = require('async');
const errors = require('./lib/errors');
const openbadger = require('./openbadger');
const _ = require('underscore');

const ENDPOINT = process.env['CSOL_AESTIMIA_URL'];
const SECRET = process.env['CSOL_AESTIMIA_SECRET'];
const CSOL_HOST = process.env['CSOL_HOST'];

if (!ENDPOINT)
  throw new Error('Must specify CSOL_AESTIMIA_URL in the environment');

if (!SECRET)
  throw new Error('Must specify CSOL_AESTIMIA_SECRET in the environment');

if (!CSOL_HOST)
  throw new Error('Must specify CSOL_HOST in the environment');

var aestimia = new Api(ENDPOINT, {

  submit: function (application, callback) {
    var api = this;
    var description = (application.description||'').trim().replace(/[^a-z0-9\s]/ig, '');
    var wordcount = !!description ? description.split(/\s+/).length : 0;
    var minWordCount = 10;

    application.getLearner()
      .complete(function (err, learner) {
        if (err)
          return callback(err);

          application.getEvidence()
            .complete(function (err, evidence) {
              if (err)
                return callback(err);

              evidence = evidence || [];

              if (!evidence.length && wordcount < minWordCount)
                return callback('Insufficient evidence for this application');

              openbadger.getBadge(application.badgeId, function (err, data) {
                var badge = data.badge;

                // console.log('Application:', application);
                // console.log('Learner:', learner);
                // console.log('Evidence:', evidence);
                // console.log('Badge:', badge);

                var submission = {
                  criteriaUrl: api.getFullUrl(CSOL_HOST, badge.url),
                  onChangeUrl: api.getFullUrl(CSOL_HOST, '/applications'),
                  achievement: {
                    name: badge.name,
                    description: badge.description,
                    imageUrl: CSOL_HOST + badge.image
                  },
                  classifications: badge.categories || [],
                  evidence: [],
                  rubric: badge.rubric || {items: [{text: 'Has done some work', required: true}]}
                };

                if (learner.email)
                  submission.learner = learner.email;

                if (learner.underage)
                  submission.cannedResponses = [
                    'You did a great job!',
                    'You went above and beyond.',
                    'Keep up the good work!',
                    'Good job.',
                    'You met all the criteria needed to earn this badge.',
                    'Creative and thoughtful work.',
                    'Nice reflection of your work.',
                    'You didn\'t submit relevant evidence.',
                    'Your evidence did not properly reflect the criteria.',
                    'Good work! But you still have a few criteria to meet to earn this badge. Make sure you take a look at all the criteria before reapplying.'
                  ];

                if (application.description) {
                  submission.evidence.push({
                    url: api.getFullUrl(CSOL_HOST, '/evidence/' + application.id + '/' + application.getHash()),
                    mediaType: 'link',
                    reflection: application.description
                  })
                }

                evidence.forEach(function(item, index) {
                  var type = item.mediaType.split('/')[0];
                  if (type !== 'image') type = 'link';

                  var obj = {
                    url: api.getFullUrl(CSOL_HOST, item.getLocationUrl()),
                    mediaType: type
                  };

                  submission.evidence.push(obj);
                });

                api.post('/submission', {json:submission}, function (err, rsp) {
                  if (err)
                    return callback(err);

                  callback(null, (rsp||{}).id);
                });
              });
            });
      });
  },

  update: function (application, callback) {
    var api = this;

    var submissionId = application.submissionId;
    var latestReview = application.getReview();

    if (!submissionId)
      return callback('Application has not yet been submitted');

    this.get('/submissions/' + submissionId, function (err, submission) {
      var rubrics = submission.rubric.items;
      var reviews = submission.reviews;

      // Bail early, if there are no reviews
      if (!reviews.length)
        return callback(null, application);

      // Sort the reviews by (ascending) date, if required
      if (reviews.length > 1) {
        reviews.sort(function(a, b) {
          if (a.date === b.date)
            return 0;
          return a.date < b.date;
        });
      }

      // Take the most recent review
      var review = reviews.pop();

      // If we've already seen it, bail
      if (review._id === latestReview._id)
        return callback(null, application);

      var satisfiedRubrics = review.satisfiedRubrics;
      var satisfied = false;

      // If something is satisfied, see if it's enough to award the badge
      if (satisfiedRubrics.length) {
        satisfied = true;

        rubrics.forEach(function (rubric, index) {
          var rubricSatisfied = !rubric.required || (satisfiedRubrics.indexOf(index) >= 0);
          satisfied &= rubricSatisfied;
        });
      }

      var state = satisfied ? 'accepted' : 'rejected';

      if (state !== application.state)
        if (state === 'accepted')
          application.getLearner()
            .complete(function (err, learner) {
              if (err || !learner) return;

              openbadger.awardBadge({
                learner: learner,
                badge: application.badgeId
              }, function (err, assertionUrl) {
                if (err)
                  return console.log(err); // Should probably log this

                // TO DO - email applicant about change of application state

                // console.log('Badge awarded:', assertionUrl);
              });
            });

      application.updateAttributes({
        state: state,
        latestReview: JSON.stringify(review)
      })
        .complete(function(err) {
          if (err)
            return callback(err, application);

          callback(null, application);
        });
    });
  }

});

aestimia.defaultOptions = {
  auth: {
    username: 'api',
    password: SECRET,
    sendImmediately: false
  }
};

module.exports = aestimia;
module.exports.healthCheck = function(meta, cb) {
  // A random email should guarantee we bust through any caches.
  var email = 'healthCheck_test_' +
              Math.floor(Math.random() * 100000) + '@sparcedge.com';

  meta.notes = ENDPOINT;
  aestimia.get('/submissions?learner=' + encodeURIComponent(email), cb);
};
